/* global L, flatpickr */

// Create namespace for the application using IIFE pattern
window.EveryStreet = (function() {
    // Private variables
    let map = null;
    let layerGroup = null;
    let socket = null;
    let liveTracker = null;

    const mapLayers = {
        trips: { layer: null, visible: true, color: '#BB86FC', order: 1, opacity: 0.4 },
        historicalTrips: { layer: null, visible: false, color: '#03DAC6', order: 2, opacity: 0.4 },
        matchedTrips: { layer: null, visible: false, color: '#CF6679', order: 3, opacity: 0.4 },
        osmBoundary: { layer: null, visible: false, color: '#03DAC6', order: 4, opacity: 0.7 },
        osmStreets: { layer: null, visible: false, color: '#FF0266', order: 5, opacity: 0.7 },
        streetCoverage: { 
            layer: null, 
            visible: false, // Set to false to hide by default
            color: '#00FF00', 
            order: 6, 
            opacity: 0.7,
            name: 'Street Coverage'
        },
        customPlaces: { 
            layer: L.layerGroup(), 
            visible: false, 
            color: '#FF9800', 
            order: 7, 
            opacity: 0.5 
        }
    };

    // Add to the private variables at the top of the IIFE
    const mapSettings = {
        highlightRecentTrips: true
    };

    // At the top of app.js, add this flag
    let isInitialized = false;

    // Private functions
    function initializeMap() {
        const mapElement = document.getElementById('map');
        if (!mapElement) {
            console.error('Map container not found');
            return;
        }

        try {
            // Initialize map with a default center and lower zoom level
            map = L.map('map', {
                center: [37.0902, -95.7129],
                zoom: 4,
                zoomControl: true,
                attributionControl: false
            });

            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                maxZoom: 19,
                attribution: ''
            }).addTo(map);

            layerGroup = L.layerGroup().addTo(map);
    
            L.control.zoom({
                position: 'topright'
            }).addTo(map);
    
            L.control.scale({
                imperial: true,
                metric: true,
                position: 'bottomright'
            }).addTo(map);
    
            map.setMaxBounds([
                [-90, -180],
                [90, 180]
            ]);
    
            // Only set initial view on first load
            if (!window.mapInitialized) {
                fetch('/api/last_trip_point')
                    .then(response => response.json())
                    .then(data => {
                        if (data.lastPoint) {
                            const [lng, lat] = data.lastPoint;
                            // Animate to the last point location with a moderate zoom level
                            map.flyTo([lat, lng], 11, {
                                duration: 2,
                                easeLinearity: 0.25
                            });
                            window.mapInitialized = true;
                        } else {
                            // Default view if no last point is available
                            map.setView([31.550020, -97.123354], 14);
                            window.mapInitialized = true;
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching last trip point:', error);
                        // Default view on error
                        map.setView([37.0902, -95.7129], 4);
                        window.mapInitialized = true;
                    });
            }
    
            console.log('Map initialized successfully');
    
        } catch (error) {
            console.error('Error initializing Leaflet map:', error);
        }
    }

    function setInitialDates() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];
        
        // Only set if not already set during this session
        if (!window.datesInitialized) {
            localStorage.setItem('startDate', todayStr);
            localStorage.setItem('endDate', todayStr);
            window.datesInitialized = true;
        }
    }

    function initializeDatePickers() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const commonConfig = {
            dateFormat: "Y-m-d",
            maxDate: "today",
            defaultDate: today,
            enableTime: false,
            onChange: function() {}, // Empty onChange to prevent automatic updates
            onClose: function() {}, // Empty onClose to prevent automatic updates
            static: true // Prevents automatic updates on initialization
        };

        if (document.getElementById('start-date')) {
            flatpickr("#start-date", commonConfig);
        }

        if (document.getElementById('end-date')) {
            flatpickr("#end-date", commonConfig);
        }
    }
    function showLoadingOverlay(message = 'Loading trips') {
        const loadingOverlay = document.querySelector('.loading-overlay');
        const loadingText = document.getElementById('loading-text');
        const loadingBar = document.getElementById('loading-bar');
        
        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
            loadingText.textContent = `${message}: 0%`;
            loadingBar.style.width = '0%';
            loadingBar.setAttribute('aria-valuenow', '0');
        }
    }

    function updateLoadingProgress(percentage, message = null) {
        const loadingText = document.getElementById('loading-text');
        const loadingBar = document.getElementById('loading-bar');
        
        if (loadingText && loadingBar) {
            const currentMessage = message || loadingText.textContent.split(':')[0];
            loadingText.textContent = `${currentMessage}: ${Math.round(percentage)}%`;
            loadingBar.style.width = `${percentage}%`;
            loadingBar.setAttribute('aria-valuenow', percentage);
        }
    }

    function hideLoadingOverlay() {
        const loadingOverlay = document.querySelector('.loading-overlay');
        if (loadingOverlay) {
            // Add a small delay to ensure user sees 100%
            setTimeout(() => {
                loadingOverlay.style.display = 'none';
            }, 500);
        }
    }

    function getFilterParams() {
        const params = new URLSearchParams();
        params.append('start_date', document.getElementById('start-date').value);
        params.append('end_date', document.getElementById('end-date').value);
        return params;
    }

    async function fetchTrips() {
        const loadingManager = getLoadingManager();
        loadingManager.startOperation('Loading Trips');
        loadingManager.addSubOperation('fetch', 0.5);
        loadingManager.addSubOperation('display', 0.5);
    
        try {
            // Get dates from localStorage or date inputs
            const startDate = localStorage.getItem('startDate') || document.getElementById('start-date').value;
            const endDate = localStorage.getItem('endDate') || document.getElementById('end-date').value;
    
            if (!startDate || !endDate) {
                console.warn('No dates selected');
                return;
            }
    
            // Update date inputs to match localStorage if needed
            document.getElementById('start-date').value = startDate;
            document.getElementById('end-date').value = endDate;
    
            // Fetch data - 50% of total progress
            loadingManager.updateSubOperation('fetch', 50);
            const params = new URLSearchParams({ 
                start_date: startDate,
                end_date: endDate 
            });
            const url = `/api/trips?${params.toString()}`;
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const geojson = await response.json();
            loadingManager.updateSubOperation('fetch', 100);
    
            // Display data - 50% of total progress
            loadingManager.updateSubOperation('display', 50);
            
            // Update trips table if it exists
            if (window.tripsTable) {
                const formattedTrips = geojson.features
                    .filter(trip => trip.properties.imei !== 'HISTORICAL')
                    .map(trip => ({
                        ...trip.properties,
                        gps: trip.geometry,
                        destination: trip.properties.destination || 'N/A',
                        isCustomPlace: trip.properties.isCustomPlace || false,
                        distance: parseFloat(trip.properties.distance).toFixed(2)
                    }));
    
                await new Promise((resolve) => {
                    window.tripsTable.clear().rows.add(formattedTrips).draw();
                    setTimeout(resolve, 100);
                });
            }
            
            // Update map only if we're on a page with a map
            const mapElement = document.getElementById('map');
            if (mapElement && map && layerGroup) {
                const regularTrips = geojson.features.filter(feature => 
                    feature.properties.imei !== 'HISTORICAL'
                );
                const historicalTrips = geojson.features.filter(feature => 
                    feature.properties.imei === 'HISTORICAL'
                );
    
                mapLayers.trips.layer = {
                    type: 'FeatureCollection',
                    features: regularTrips
                };
                
                mapLayers.historicalTrips.layer = {
                    type: 'FeatureCollection',
                    features: historicalTrips
                };
    
                await updateMap();
            }
            
            loadingManager.updateSubOperation('display', 100);
    
        } catch (error) {
            console.error('Error fetching trips:', error);
            throw error;
        } finally {
            loadingManager.finish();
        }
    }

    async function fetchMatchedTrips() {
        let url = '/api/matched_trips';
        const params = new URLSearchParams();

        if (document.getElementById('start-date')) params.append('start_date', document.getElementById('start-date').value);
        if (document.getElementById('end-date')) params.append('end_date', document.getElementById('end-date').value);

        if (params.toString()) {
            url += `?${params.toString()}`;
        }

        try {
            const response = await fetch(url);
            const geojson = await response.json();
            mapLayers.matchedTrips.layer = geojson;
        } catch (error) {
            console.error('Error fetching matched trips:', error);
        }
    }
    async function updateMap(fitBounds = false) {
        layerGroup.clearLayers();
        
        const orderedLayers = Object.entries(mapLayers)
            .sort((a, b) => a[1].order - b[1].order);
    
        const sixHoursAgo = new Date(Date.now() - (6 * 60 * 60 * 1000));
    
        // Filter visible layers that need processing
        const visibleLayers = orderedLayers.filter(([, layerInfo]) => 
            layerInfo.visible && layerInfo.layer);
    
        // Process layers sequentially with progress updates
        for (let i = 0; i < visibleLayers.length; i++) {
            const [layerName, layerInfo] = visibleLayers[i];
            const progress = (i / visibleLayers.length) * 100;
            updateLoadingProgress(progress, 'Updating map visualization');

            await new Promise(resolve => {
                if (layerName === 'streetCoverage' || layerName === 'customPlaces') {
                    layerInfo.layer.addTo(layerGroup);
                    resolve();
                } else if (layerName === 'trips' || layerName === 'historicalTrips' || layerName === 'matchedTrips') {
                    L.geoJSON(layerInfo.layer, {
                        style: (feature) => {
                            const startTime = new Date(feature.properties.startTime);
                            const isRecent = startTime > sixHoursAgo;
                            const shouldHighlight = mapSettings.highlightRecentTrips && isRecent;
                            
                            return {
                                color: shouldHighlight ? '#FF5722' : layerInfo.color,
                                weight: shouldHighlight ? 4 : 2,
                                opacity: shouldHighlight ? 0.8 : layerInfo.opacity,
                                className: shouldHighlight ? 'recent-trip' : ''
                            };
                        },
                        onEachFeature: (feature, layer) => {
                            const timezone = feature.properties.timezone || 'America/Chicago';
                            const startTime = new Date(feature.properties.startTime);
                            const endTime = new Date(feature.properties.endTime);

                            const formatter = new Intl.DateTimeFormat('en-US', {
                                dateStyle: 'short',
                                timeStyle: 'short',
                                timeZone: timezone,
                                hour12: true
                            });

                            const startTimeStr = formatter.format(startTime);
                            const endTimeStr = formatter.format(endTime);

                            const isRecent = startTime > sixHoursAgo;
                            const shouldHighlight = mapSettings.highlightRecentTrips && isRecent;
                            
                            const popupContent = document.createElement('div');
                            popupContent.innerHTML = `
                                <strong>Trip ID:</strong> ${feature.properties.transactionId}<br>
                                <strong>Start Time:</strong> ${startTimeStr}<br>
                                <strong>End Time:</strong> ${endTimeStr}<br>
                                <strong>Distance:</strong> ${parseFloat(feature.properties.distance).toFixed(2)} miles<br>
                                ${shouldHighlight ? '<br><strong>(Recent Trip)</strong>' : ''}<br>
                                <button class="btn btn-danger btn-sm mt-2 delete-matched-trip" 
                                        data-trip-id="${feature.properties.transactionId}">
                                    Delete Matched Trip
                                </button>
                            `;

                            // Add click handler for the delete button
                            popupContent.querySelector('.delete-matched-trip').addEventListener('click', async (e) => {
                                e.preventDefault();
                                const tripId = e.target.dataset.tripId;
                                
                                if (confirm('Are you sure you want to delete this matched trip? You can re-run map matching to recreate it.')) {
                                    try {
                                        const response = await fetch(`/api/matched_trips/${tripId}`, {
                                            method: 'DELETE',
                                            headers: {
                                                'Content-Type': 'application/json'
                                            }
                                        });

                                        if (!response.ok) {
                                            throw new Error('Failed to delete matched trip');
                                        }

                                        layer.closePopup();
                                        fetchTrips(); // Refresh the trips display
                                        alert('Matched trip deleted successfully');
                                    } catch (error) {
                                        console.error('Error deleting matched trip:', error);
                                        alert('Error deleting matched trip. Please try again.');
                                    }
                                }
                            });

                            layer.bindPopup(popupContent);
                        }
                    }).addTo(layerGroup);
                    
                    // Use requestAnimationFrame to ensure smooth rendering
                    requestAnimationFrame(resolve);
                } else if ((layerName === 'osmBoundary' || layerName === 'osmStreets') && layerInfo.layer) {
                    layerInfo.layer.setStyle({ 
                        color: layerInfo.color,
                        opacity: layerInfo.opacity
                    }).addTo(layerGroup);
                    resolve();
                } else if (layerName === 'customPlaces') {
                    L.geoJSON(layerInfo.layer, {
                        style: {
                            color: layerInfo.color,
                            opacity: layerInfo.opacity
                        }
                    }).addTo(layerGroup);
                    resolve();
                } else {
                    resolve();
                }
            });
        }

        // Handle bounds fitting if requested
        if (fitBounds) {
            let bounds = L.latLngBounds();
            let validBoundsFound = false;

            for (const layerName in mapLayers) {
                if (mapLayers[layerName].visible && mapLayers[layerName].layer) {
                    try {
                        const layerBounds = L.geoJSON(mapLayers[layerName].layer).getBounds();
                        if (layerBounds.isValid()) {
                            bounds.extend(layerBounds);
                            validBoundsFound = true;
                        }
                    } catch (e) {
                        if (mapLayers[layerName].layer.getBounds) {
                            const layerBounds = mapLayers[layerName].layer.getBounds();
                            if (layerBounds.isValid()) {
                                bounds.extend(layerBounds);
                                validBoundsFound = true;
                            }
                        }
                    }
                }
            }

            if (validBoundsFound) {
                map.fitBounds(bounds);
            }
        }

        // Final progress update
        updateLoadingProgress(100, 'Map update complete');
    }


    function initializeLayerControls() {
        const layerToggles = document.getElementById('layer-toggles');
        if (!layerToggles) {
            console.warn("Element with ID 'layer-toggles' not found.");
            return;
        }
        layerToggles.innerHTML = '';

        for (const [layerName, layerInfo] of Object.entries(mapLayers)) {
            const layerControl = document.createElement('div');
            layerControl.classList.add('layer-control');
            layerControl.dataset.layerName = layerName;

            // Skip color picker and opacity slider for streetCoverage and customPlaces layers
            const showControls = !['streetCoverage', 'customPlaces'].includes(layerName);
            const colorPickerHtml = showControls ? 
                `<input type="color" id="${layerName}-color" value="${layerInfo.color}">` : '';
            const opacitySliderHtml = showControls ? 
                `<label for="${layerName}-opacity">Opacity:</label>
                 <input type="range" id="${layerName}-opacity" min="0" max="1" step="0.1" value="${layerInfo.opacity}">` : '';

            layerControl.innerHTML = `
                <label class="custom-checkbox">
                    <input type="checkbox" id="${layerName}-toggle" ${layerInfo.visible ? 'checked' : ''}>
                    <span class="checkmark"></span>
                </label>
                <label for="${layerName}-toggle">${layerInfo.name || layerName}</label>
                ${colorPickerHtml}
                ${opacitySliderHtml}
            `;
            layerToggles.appendChild(layerControl);

            document.getElementById(`${layerName}-toggle`).addEventListener('change', (e) => toggleLayer(layerName, e.target.checked));
            if (showControls) {
                document.getElementById(`${layerName}-color`).addEventListener('change', (e) => changeLayerColor(layerName, e.target.value));
                document.getElementById(`${layerName}-opacity`).addEventListener('input', (e) => changeLayerOpacity(layerName, e.target.value));
            }
        }
    }
    function toggleLayer(layerName, visible) {
        if (!mapLayers[layerName]) {
            console.warn(`Layer ${layerName} not found`);
            return;
        }
        mapLayers[layerName].visible = visible;
        updateMap();
        updateLayerOrderUI();
    }

    function changeLayerColor(layerName, color) {
        mapLayers[layerName].color = color;
        updateMap();
    }

    function changeLayerOpacity(layerName, opacity) {
        mapLayers[layerName].opacity = parseFloat(opacity);
        updateMap();
    }

    function updateLayerOrderUI() {
        const layerOrder = document.getElementById('layer-order');
        if (!layerOrder) {
            console.warn('Layer order element not found');
            return;
        }
        layerOrder.innerHTML = '<h3>Layer Order (Drag to reorder)</h3>';



        const orderedLayers = Object.entries(mapLayers)
            .filter(([, layerInfo]) => layerInfo.visible)
            .sort((a, b) => b[1].order - a[1].order);

        const ul = document.createElement('ul');
        ul.id = 'layer-order-list';
        orderedLayers.forEach(([layerName]) => {
            const li = document.createElement('li');
            li.textContent = layerName;
            li.draggable = true;
            li.dataset.layer = layerName;
            ul.appendChild(li);
        });

        layerOrder.appendChild(ul);
        initializeDragAndDrop();
    }

    function initializeDragAndDrop() {
        const layerList = document.getElementById('layer-order-list');
        let draggedItem = null;

        layerList?.addEventListener('dragstart', (e) => {
            draggedItem = e.target;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', '');
        });

        layerList?.addEventListener('dragover', (e) => {
            e.preventDefault();
            const targetItem = e.target.closest('li');
            if (targetItem && targetItem !== draggedItem) {
                const rect = targetItem.getBoundingClientRect();
                const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
                layerList.insertBefore(draggedItem, next ? targetItem.nextSibling : targetItem);
            }
        });

        layerList?.addEventListener('dragend', () => {
            updateLayerOrder();
        });
    }

    function updateLayerOrder() {
        const layerList = document.getElementById('layer-order-list');
        if (!layerList) return;
        
        const layers = Array.from(layerList.querySelectorAll('li'));
        const totalLayers = layers.length;
        layers.forEach((layer, index) => {
            mapLayers[layer.dataset.layer].order = totalLayers - index;
        });
        updateMap();
    }

    function validateLocation() {
        const locationInput = document.getElementById('location-input');
        const locationTypeInput = document.getElementById('location-type');
        if (!locationInput || !locationTypeInput || !locationInput.value || !locationTypeInput.value) return;

        fetch('/api/validate_location', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                location: locationInput.value, 
                locationType: locationTypeInput.value 
            }),
        })
        .then(response => response.json())
        .then(data => {
            if (data) {
                // Store the full location object in the hidden input
                locationInput.setAttribute('data-location', JSON.stringify(data));
                locationInput.setAttribute('data-display-name', data.display_name || data.name || locationInput.value);
                
                // Store for other functions that might need it
                window.validatedLocation = data;
                
                
                alert('Location validated successfully!');
            } else {
                alert('Location not found. Please check your input.');
            }
        })
        .catch(error => {
            console.error('Error validating location:', error);
            alert('Error validating location. Please try again.');
        });
    }

    function generateOSMData(streetsOnly) {
        if (!window.validatedLocation) {
            alert('Please validate a location first.');
            return;
        }

        fetch('/api/generate_geojson', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ location: window.validatedLocation, streetsOnly }),
        })
        .then(response => response.json())
        .then(geojson => {
            if (!geojson || !geojson.type || geojson.type !== 'FeatureCollection') {
                throw new Error('Invalid GeoJSON data');
            }

            if (streetsOnly) {
                mapLayers.osmStreets.layer = L.geoJSON(geojson, {
                    style: {
                        color: mapLayers.osmStreets.color,
                        weight: 2,
                        opacity: 0.7
                    }
                });
            } else {
                mapLayers.osmBoundary.layer = L.geoJSON(geojson, {
                    style: {
                        color: mapLayers.osmBoundary.color,
                        weight: 2,
                        opacity: 0.7
                    }
                });
            }
            updateMap();
            updateLayerOrderUI();
        })
        .catch(error => {
            console.error('Error generating OSM data:', error);
        });
    }
    function initializeEventListeners() {
        // Apply filters button
        const applyFiltersButton = document.getElementById('apply-filters');
        if (applyFiltersButton && !applyFiltersButton.hasListener) {
            applyFiltersButton.hasListener = true;
            applyFiltersButton.addEventListener('click', () => {
                const startDate = document.getElementById('start-date').value;
                const endDate = document.getElementById('end-date').value;
                localStorage.setItem('startDate', startDate);
                localStorage.setItem('endDate', endDate);
                fetchTrips();
                fetchMetrics();  // Add this line
            });
        }

        // Map controls toggle
        const mapControlsToggle = document.getElementById('controls-toggle');
        if (mapControlsToggle) {
            mapControlsToggle.addEventListener('click', function() {
                const mapControls = document.getElementById('map-controls');
                const controlsContent = document.getElementById('controls-content');
                mapControls?.classList.toggle('minimized');
                const icon = this.querySelector('i');
                if (mapControls?.classList.contains('minimized')) {
                    icon?.classList.replace('fa-chevron-up', 'fa-chevron-down');
                    if (controlsContent) controlsContent.style.display = 'none';
                } else {
                    icon?.classList.replace('fa-chevron-down', 'fa-chevron-up');
                    if (controlsContent) controlsContent.style.display = 'block';
                }
            });
        }

        // OSM Controls
        const validateLocationButton = document.getElementById('validate-location');
        if (validateLocationButton) {
            validateLocationButton.addEventListener('click', validateLocation);
        }

        const generateBoundaryButton = document.getElementById('generate-boundary');
        if (generateBoundaryButton) {
            generateBoundaryButton.addEventListener('click', () => generateOSMData(false));
        }

        const generateStreetsButton = document.getElementById('generate-streets');
        if (generateStreetsButton) {
            generateStreetsButton.addEventListener('click', () => generateOSMData(true));
        }

        // Map matching buttons
        const mapMatchTripsButton = document.getElementById('map-match-trips');
        if (mapMatchTripsButton) {
            mapMatchTripsButton.addEventListener('click', mapMatchTrips);
        }

        const mapMatchHistoricalTripsButton = document.getElementById('map-match-historical-trips');
        if (mapMatchHistoricalTripsButton) {
            mapMatchHistoricalTripsButton.addEventListener('click', mapMatchHistoricalTrips);
        }

        // Historical data loading
        const loadHistoricalDataButton = document.getElementById('load-historical-data');
        if (loadHistoricalDataButton) {
            loadHistoricalDataButton.addEventListener('click', loadHistoricalData);
        }

        // Date preset buttons
        document.querySelectorAll('.date-preset').forEach(button => {
            button.addEventListener('click', function() {
                const range = this.dataset.range;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                let startDate = new Date(today);
                let endDate = new Date(today);

                if (range === 'all-time') {
                    // Fetch first trip date from API
                    showLoadingOverlay();
                    fetch('/api/first_trip_date')
                        .then(response => response.json())
                        .then(data => {
                            startDate = new Date(data.first_trip_date);
                            
                            // Update the flatpickr instances
                            const startDatePicker = document.getElementById('start-date')._flatpickr;
                            const endDatePicker = document.getElementById('end-date')._flatpickr;
                            
                            startDatePicker.setDate(startDate);
                            endDatePicker.setDate(endDate);
                            
                            // Store the new dates in localStorage
                            localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
                            localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);
                            
                            // Fetch new data
                            fetchTrips();
                            fetchMetrics();
                        })
                        .catch(error => {
                            console.error('Error fetching first trip date:', error);
                        })
                        .finally(() => {
                            hideLoadingOverlay();
                        });
                    return; // Exit early since we're handling the update in the promise
                }

                switch(range) {
                    case 'today':
                        break;
                    case 'yesterday':
                        startDate.setDate(startDate.getDate() - 1);
                        break;
                    case 'last-week':
                        startDate.setDate(startDate.getDate() - 7);
                        break;
                    case 'last-month':
                        startDate.setDate(startDate.getDate() - 30);
                        break;
                    case 'last-6-months':
                        startDate.setMonth(startDate.getMonth() - 6);
                        break;
                    case 'last-year':
                        startDate.setFullYear(startDate.getFullYear() - 1);
                        break;
                }

                // Update the flatpickr instances
                const startDatePicker = document.getElementById('start-date')._flatpickr;
                const endDatePicker = document.getElementById('end-date')._flatpickr;
                
                startDatePicker.setDate(startDate);
                endDatePicker.setDate(endDate);

                // Store the new dates in localStorage
                localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
                localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

                // Fetch new data
                fetchTrips();
                fetchMetrics();
            });
        });

        const fetchTripsButton = document.getElementById('fetch-trips-range');
        if (fetchTripsButton) {
            fetchTripsButton.addEventListener('click', fetchTripsInRange);
        }

        // Add highlight recent trips toggle listener
        const highlightToggle = document.getElementById('highlight-recent-trips');
        if (highlightToggle) {
            highlightToggle.addEventListener('change', function() {
                mapSettings.highlightRecentTrips = this.checked;
                updateMap();
            });
        }

        const highlightButton = document.getElementById('highlight-recent-trips');
        if (highlightButton) {
            highlightButton.addEventListener('click', function() {
                mapSettings.highlightRecentTrips = !mapSettings.highlightRecentTrips;
                this.classList.toggle('inactive');
                const buttonText = this.querySelector('.button-text');
                buttonText.textContent = mapSettings.highlightRecentTrips 
                    ? 'Disable Recent Trips Highlight' 
                    : 'Enable Recent Trips Highlight';
                updateMap();
            });

            // Set initial state
            if (!mapSettings.highlightRecentTrips) {
                highlightButton.classList.add('inactive');
                highlightButton.querySelector('.button-text').textContent = 'Enable Recent Trips Highlight';
            }
        }

        const generateCoverageBtn = document.getElementById('generate-coverage');
        if (generateCoverageBtn) {
            generateCoverageBtn.addEventListener('click', () => EveryStreet.generateStreetCoverage());
        }
    }

    function fetchMetrics() {
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        const imeiInput = document.getElementById('imei');
        
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return;

        const imeiValue = imeiInput ? imeiInput.value : '';

        fetch(`/api/metrics?start_date=${startDateInput.value}&end_date=${endDateInput.value}&imei=${imeiValue}`)
            .then(response => response.json())
            .then(metrics => {
                const elements = {
                    'total-trips': metrics.total_trips,
                    'total-distance': metrics.total_distance,
                    'avg-distance': metrics.avg_distance,
                    'avg-start-time': metrics.avg_start_time,
                    'avg-driving-time': metrics.avg_driving_time
                };

                Object.entries(elements).forEach(([id, value]) => {
                    const element = document.getElementById(id);
                    if (element) {
                        element.textContent = value;
                    }
                });
            })
            .catch(error => {
                console.error('Error fetching metrics:', error);
            });
    }

    function mapMatchTrips() {
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return;

        showLoadingOverlay('Map matching trips');

        fetch('/api/map_match_trips', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: startDateInput.value,
                end_date: endDateInput.value
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (data.status === 'success') {
                updateLoadingProgress(100, 'Map matching complete');
                alert(data.message);
                fetchTrips();
            }
        })
        .catch(error => {
            console.error('Error initiating map matching for trips:', error);
        });
    }
    function mapMatchHistoricalTrips() {
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        if (!startDateInput || !endDateInput || !startDateInput.value || !endDateInput.value) return;

        showLoadingOverlay();

        fetch('/api/map_match_historical_trips', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: startDateInput.value,
                end_date: endDateInput.value
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
                fetchTrips();
            } else {
                console.error(`Error: ${data.message}`);
            }
        })
        .catch(error => {
            console.error('Error initiating map matching for historical trips:', error);
        })
        .finally(() => {
            hideLoadingOverlay();
        });
    }

    function loadHistoricalData() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;

        if (!startDate || !endDate) {
            alert('Please select both start and end dates');
            return;
        }

        showLoadingOverlay();

        fetch('/load_historical_data', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: startDate,
                end_date: endDate
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            alert(data.message);
            fetchTrips(); // Refresh the trips display
        })
        .catch(error => {
            console.error('Error loading historical data:', error);
            alert('Error loading historical data. Please check the console for details.');
        })
        .finally(() => {
            hideLoadingOverlay();
        });
    }

    function initializeDatePresets() {
        document.querySelectorAll('.date-preset').forEach(button => {
            button.addEventListener('click', function() {
                const range = this.dataset.range;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                let startDate = new Date(today);
                let endDate = new Date(today);

                if (range === 'all-time') {
                    // Fetch first trip date from API
                    showLoadingOverlay();
                    fetch('/api/first_trip_date')
                        .then(response => response.json())
                        .then(data => {
                            startDate = new Date(data.first_trip_date);
                            
                            // Update the flatpickr instances
                            const startDatePicker = document.getElementById('start-date')._flatpickr;
                            const endDatePicker = document.getElementById('end-date')._flatpickr;
                            
                            startDatePicker.setDate(startDate);
                            endDatePicker.setDate(endDate);
                            
                            // Store the new dates in localStorage
                            localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
                            localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);
                            
                            // Fetch new data
                            fetchTrips();
                            fetchMetrics();
                        })
                        .catch(error => {
                            console.error('Error fetching first trip date:', error);
                        })
                        .finally(() => {
                            hideLoadingOverlay();
                        });
                    return; // Exit early since we're handling the update in the promise
                }

                switch(range) {
                    case 'today':
                        break;
                    case 'yesterday':
                        startDate.setDate(startDate.getDate() - 1);
                        endDate.setDate(endDate.getDate() - 1);
                        break;
                    case 'last-week':
                        startDate.setDate(startDate.getDate() - 7);
                        break;
                    case 'last-month':
                        startDate.setDate(startDate.getDate() - 30);
                        break;
                    case 'last-6-months':
                        startDate.setMonth(startDate.getMonth() - 6);
                        break;
                    case 'last-year':
                        startDate.setFullYear(startDate.getFullYear() - 1);
                        break;
                }

                // Update the flatpickr instances
                const startDatePicker = document.getElementById('start-date')._flatpickr;
                const endDatePicker = document.getElementById('end-date')._flatpickr;
                
                startDatePicker.setDate(startDate);
                endDatePicker.setDate(endDate);

                // Store the new dates in localStorage
                localStorage.setItem('startDate', startDate.toISOString().split('T')[0]);
                localStorage.setItem('endDate', endDate.toISOString().split('T')[0]);

                // Fetch new data
                fetchTrips();
                fetchMetrics();
            });
        });
    }

    function fetchTripsInRange() {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;

        if (!startDate || !endDate) {
            alert('Please select both start and end dates');
            return;
        }

        showLoadingOverlay();

        fetch('/api/fetch_trips_range', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: startDate,
                end_date: endDate
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            if (data.status === 'success') {
                alert(data.message);
                fetchTrips(); // Refresh the trips display
            } else {
                console.error(`Error: ${data.message}`);
                alert('Error fetching trips. Please check the console for details.');
            }
        })
        .catch(error => {
            console.error('Error fetching trips in range:', error);
            alert('Error fetching trips. Please check the console for details.');
        })
        .finally(() => {
            hideLoadingOverlay();
        });
    }

    function visualizeStreetCoverage(coverageData) {
        // Clear existing layer if it exists
        if (mapLayers.streetCoverage.layer) {
            layerGroup.removeLayer(mapLayers.streetCoverage.layer);
        }
        
        // Create new GeoJSON layer
        mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
            style: function(feature) {
                return {
                    color: feature.properties.driven ? '#00FF00' : '#FF4444',
                    weight: 3,
                    opacity: feature.properties.driven ? 0.8 : 0.4
                };
            },
            onEachFeature: function(feature, layer) {
                layer.bindPopup(`
                    <strong>${feature.properties.name || 'Unnamed Street'}</strong><br>
                    Status: ${feature.properties.driven ? 'Driven' : 'Not driven yet'}
                `);
            }
        });
        
        updateCoverageStats(coverageData);
        updateMap();
    }

    // Add helper function to update the coverage stats UI
    function updateCoverageStats(coverageData) {
        const statsDiv = document.getElementById('coverage-stats');
        const progressBar = document.getElementById('coverage-progress');
        const detailsSpan = document.getElementById('coverage-details');
        
        statsDiv.classList.remove('d-none');
        
        const percentage = coverageData.coverage_percentage;
        progressBar.style.width = `${percentage}%`;
        progressBar.setAttribute('aria-valuenow', percentage);
        
        const totalMiles = (coverageData.total_length * 0.000621371).toFixed(2);
        const drivenMiles = (coverageData.driven_length * 0.000621371).toFixed(2);
        
        detailsSpan.innerHTML = `
            ${percentage.toFixed(1)}% complete<br>
            ${drivenMiles} / ${totalMiles} miles driven
        `;
    }

    function generateStreetCoverage() {
        if (!window.validatedLocation) {
            alert('Please validate a location first.');
            return;
        }
        
        const coverageButton = document.getElementById('generate-coverage');
        const originalText = coverageButton.innerHTML;
        coverageButton.disabled = true;
        coverageButton.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...';
        
        fetch('/api/street_coverage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ location: window.validatedLocation })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(data => {
            visualizeStreetCoverage(data);n
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Error generating street coverage. Please try again.');
        })
        .finally(() => {
            coverageButton.disabled = false;
            coverageButton.innerHTML = originalText;
        });
    }

    function clearLocalStorage() {
        // Remove specific items related to your app's state
        localStorage.removeItem('startDate');
        localStorage.removeItem('endDate');
        localStorage.removeItem('sidebarCollapsed');
    }

    function initializeLiveTracking() {
        if (map && !liveTracker) {
            try {
                liveTracker = new LiveTripTracker(map);
                console.log('Live tracking initialized');
            } catch (error) {
                console.error('Error initializing live tracking:', error);
            }
        } else {
            console.warn('Map not ready or live tracker already exists');
        }
    }

    function initializeSocketIO() {
        socket = io();
        
        socket.on('connect', () => {
            console.log('Connected to WebSocket server');
        });

        socket.on('disconnect', () => {
            console.log('Disconnected from WebSocket server');
        });

        socket.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }

    function handleLocationValidationSuccess(data) {
        window.validatedLocation = data.location;
        
        // Enable relevant buttons
        document.getElementById('generate-boundary').disabled = false;
        document.getElementById('generate-streets').disabled = false;
        document.getElementById('generate-coverage').disabled = false;
        
        // Show success message
        showSuccess('Location validated successfully!');
        
        // Dispatch location validated event
        document.dispatchEvent(new Event('locationValidated'));
    }
    // Public API
    return {
        // Initialization
        initialize: function() {
            // Clear local storage items on initialization
            clearLocalStorage();
        
            // Guard against multiple initializations
            if (isInitialized) {
                console.log('App already initialized, skipping...');
                return;
            }
        
            setInitialDates(); // Set initial dates once
        
            // Ensure date pickers and date inputs are initialized before fetching data
            initializeDatePickers();
            initializeEventListeners();
            initializeDatePresets();
        
            // Initialize map first and ensure it's ready
            if (document.getElementById('map') && !document.getElementById('visits-page')) {
                initializeMap();
                if (!map || !layerGroup) {
                    console.error('Failed to initialize map components');
                    return;
                }
                initializeLayerControls();
                // Only fetch trips after confirming map is initialized
                setTimeout(() => {
                    fetchTrips();
                }, 100);
            }
        
            fetchMetrics();
            updateLayerOrderUI();
        
            // Initialize socket and live tracking
            initializeSocketIO();
            initializeLiveTracking();
        
            // Mark as initialized
            isInitialized = true;
        },

        // Public methods
        getMap: () => map,
        getLayerGroup: () => layerGroup,
        getSocket: () => socket,
        mapLayers,
        
        // Public actions
        refreshMap: updateMap,
        fetchTrips: fetchTrips,
        fetchMetrics: fetchMetrics,
        validateLocation: validateLocation,
        generateOSMData: generateOSMData,
        mapMatchTrips: mapMatchTrips,
        mapMatchHistoricalTrips: mapMatchHistoricalTrips,
        loadHistoricalData: loadHistoricalData,
        getLiveTracker: function() {
            return liveTracker;
        },
        reinitializeLiveTracking: function() {
            if (liveTracker) {
                liveTracker.cleanup();
                liveTracker = null;
            }
            initializeLiveTracking();
        },
        
        // Layer management
        toggleLayer: toggleLayer,
        changeLayerColor: changeLayerColor,
        changeLayerOpacity: changeLayerOpacity,
        updateLayerOrder: updateLayerOrder,
        mapSettings: mapSettings,
        generateStreetCoverage: generateStreetCoverage,
        updateCoverageStats: updateCoverageStats,
        visualizeStreetCoverage: visualizeStreetCoverage,
        toggleCustomPlacesLayer: function() {
            const layerInfo = mapLayers.customPlaces;
            layerInfo.visible = !layerInfo.visible;
            updateMap();
        }
    };
})();

// Initialize the application when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    EveryStreet.initialize();
});

