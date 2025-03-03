"""
tasks.py

This module contains background task functions that are scheduled via APScheduler.
Tasks include periodic trip fetching, hourly trip fetching, cleanup of stale or invalid trips,
and updating coverage for all locations.

It also contains helper functions to load/save task configuration and reinitialize the scheduler.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.base import JobLookupError

from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from map_matching import process_and_map_match_trip
from utils import validate_trip_data
from street_coverage_calculation import update_coverage_for_all_locations

# Import your database collections from a centralized module (db.py)
from db import (
    trips_collection,
    live_trips_collection,
    archived_live_trips_collection,
    task_config_collection,
)

# Set up logging.
logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)

# Create the APScheduler instance.
scheduler = AsyncIOScheduler()

#  Task configuration
AVAILABLE_TASKS = [
    # For tasks that require no parameters, schedule the parameterless function.
    {
        "id": "fetch_and_store_trips",
        "display_name": "Fetch & Store Trips",
        "default_interval_minutes": 30,
    },
    {
        "id": "periodic_fetch_trips",
        "display_name": "Periodic Trip Fetch",
        "default_interval_minutes": 30,
    },
    {
        "id": "update_coverage_for_all_locations",
        "display_name": "Update Coverage (All Locations)",
        "default_interval_minutes": 60,
    },
    {
        "id": "cleanup_stale_trips",
        "display_name": "Cleanup Stale Trips",
        "default_interval_minutes": 60,
    },
    {
        "id": "cleanup_invalid_trips",
        "display_name": "Cleanup Invalid Trips",
        "default_interval_minutes": 1440,  # once per day
    },
]


def get_task_config():
    """
    Retrieves the background task config doc from MongoDB.
    If none exists, creates a default one.
    """
    cfg = task_config_collection.find_one({"_id": "global_background_task_config"})
    if not cfg:
        cfg = {
            "_id": "global_background_task_config",
            "pausedUntil": None,
            "disabled": False,
            "tasks": {},
        }
        for t in AVAILABLE_TASKS:
            cfg["tasks"][t["id"]] = {
                "interval_minutes": t["default_interval_minutes"],
                "enabled": True,
            }
        task_config_collection.insert_one(cfg)
    return cfg


def save_task_config(cfg):
    """
    Saves the given config doc to the DB.
    """
    task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, cfg, upsert=True
    )


#  Background Task Functions


async def periodic_fetch_trips():
    """Periodically fetch trips from the Bouncie API and store them."""
    try:
        last_trip = trips_collection.find_one(sort=[("endTime", -1)])
        if last_trip and last_trip.get("endTime"):
            start_date = last_trip["endTime"]
        else:
            start_date = datetime.now(timezone.utc) - timedelta(days=7)
        end_date = datetime.now(timezone.utc)
        logger.info(f"Periodic trip fetch started from {start_date} to {end_date}")
        await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
        logger.info("Periodic trip fetch completed successfully.")
    except Exception as e:
        logger.error(f"Error during periodic trip fetch: {e}", exc_info=True)


async def hourly_fetch_trips():
    """Fetch trips from the last hour and then map-match them."""
    try:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(hours=1)
        logger.info(f"Hourly trip fetch started for range: {start_date} to {end_date}")
        await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=True)
        logger.info("Hourly trip fetch completed successfully.")

        # Map match the newly fetched trips.
        logger.info("Starting map matching for hourly fetched trips...")
        current_hour_end = datetime.now(timezone.utc)
        current_hour_start = current_hour_end - timedelta(hours=1)
        new_trips_to_match = trips_collection.find(
            {"startTime": {"$gte": current_hour_start, "$lte": current_hour_end}}
        )
        map_matched_count = 0
        for trip in new_trips_to_match:
            await process_and_map_match_trip(trip)
            map_matched_count += 1
        logger.info(
            f"Map matching completed for {map_matched_count} hourly fetched trips."
        )
    except Exception as e:
        logger.error(f"Error during hourly trip fetch: {e}", exc_info=True)


async def cleanup_stale_trips():
    """Archive trips that haven't been updated in the last 5 minutes."""
    try:
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(minutes=5)
        stale_trips = live_trips_collection.find(
            {"lastUpdate": {"$lt": stale_threshold}, "status": "active"}
        )
        for trip in stale_trips:
            trip["status"] = "stale"
            trip["endTime"] = now
            archived_live_trips_collection.insert_one(trip)
            live_trips_collection.delete_one({"_id": trip["_id"]})
    except Exception as e:
        logger.error(f"Error cleaning up stale trips: {e}", exc_info=True)


async def cleanup_invalid_trips():
    """Mark invalid trip documents based on validation failure."""
    try:
        all_trips = list(trips_collection.find({}))
        for t in all_trips:
            ok, msg = validate_trip_data(t)
            if not ok:
                logger.warning(f"Invalid trip {t.get('transactionId', '?')}: {msg}")
                trips_collection.update_one(
                    {"_id": t["_id"]}, {"$set": {"invalid": True}}
                )
        logger.info("Trip cleanup done.")
    except Exception as e:
        logger.error(f"cleanup_invalid_trips: {e}", exc_info=True)


#  Scheduler Management Functions


def reinitialize_scheduler_tasks():
    """
    Re-read the config from the DB, remove existing jobs, and re-add them with the correct intervals,
    unless globally disabled or paused.
    """
    for t in AVAILABLE_TASKS:
        job_id = t["id"]
        try:
            scheduler.remove_job(job_id)
        except JobLookupError:
            pass

    cfg = get_task_config()
    if cfg.get("disabled"):
        logger.info("Background tasks are globally disabled. No tasks scheduled.")
        return

    paused_until = cfg.get("pausedUntil")
    is_currently_paused = False
    if paused_until:
        now_utc = datetime.now(timezone.utc)
        if paused_until > now_utc:
            is_currently_paused = True

    for t in AVAILABLE_TASKS:
        task_id = t["id"]
        task_settings = cfg["tasks"].get(task_id, {})
        if not task_settings or not task_settings.get("enabled", True):
            continue
        interval = task_settings.get("interval_minutes", t["default_interval_minutes"])
        next_run_time = (
            paused_until + timedelta(seconds=1) if is_currently_paused else None
        )

        # IMPORTANT: Instead of mapping "fetch_and_store_trips" to fetch_bouncie_trips_in_range (which needs arguments),
        # we map both "fetch_and_store_trips" and "periodic_fetch_trips" to periodic_fetch_trips.
        if task_id in ("fetch_and_store_trips", "periodic_fetch_trips"):
            job_func = periodic_fetch_trips
        elif task_id == "update_coverage_for_all_locations":
            job_func = update_coverage_for_all_locations
        elif task_id == "cleanup_stale_trips":
            job_func = cleanup_stale_trips
        elif task_id == "cleanup_invalid_trips":
            job_func = cleanup_invalid_trips
        else:
            continue

        scheduler.add_job(
            job_func,
            "interval",
            minutes=interval,
            id=task_id,
            next_run_time=next_run_time,
            max_instances=1,
        )
    logger.info("Scheduler tasks reinitialized based on new config.")


def start_background_tasks():
    """
    Called at application startup to start the scheduler and initialize tasks.
    """
    if not scheduler.running:
        scheduler.start()
    reinitialize_scheduler_tasks()
