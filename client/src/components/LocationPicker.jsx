import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import 'leaflet/dist/leaflet.css';
import Icon from './Icon';

// Fix default marker icon paths (Vite doesn't resolve them automatically)
const defaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});

const NOMINATIM = 'https://nominatim.openstreetmap.org';

function formatAddress(parts = {}) {
  return [
    parts.road || parts.neighbourhood || parts.residential,
    parts.suburb || parts.village,
    parts.city || parts.town || parts.county,
    parts.state
  ]
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(', ');
}

function validPincode(value) {
  const pincode = String(value || '').trim();
  return /^[1-9]\d{5}$/.test(pincode) ? pincode : null;
}

// Dropping a pin gives coordinates but no address, so ask what is there.
export async function reverseGeocode({ lat, lng }) {
  const res = await fetch(
    `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
  );
  if (!res.ok) throw new Error('Reverse lookup failed.');
  const data = await res.json();
  const address = formatAddress(data.address) || data.display_name || '';
  if (!address) throw new Error('Nothing found at that point.');
  return { address, pincode: validPincode(data.address?.postcode) };
}

function ClickHandler({ onPick }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng);
    }
  });
  return null;
}

// Recenters the map whenever a new search result is selected.
function RecenterOnChange({ position }) {
  const map = useMap();
  useEffect(() => {
    if (position) {
      map.setView(position, 15);
    }
  }, [position, map]);
  return null;
}

export default function LocationPicker({ position, onChange, onAddressResolved }) {
  const [center] = useState(position || { lat: 12.9716, lng: 77.5946 }); // default: Bengaluru
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchedPosition, setSearchedPosition] = useState(null);
  // Collapsed to start with. A 280px map above the Place order button pushed
  // the whole form off the first screen.
  const [showMap, setShowMap] = useState(false);
  const [locating, setLocating] = useState(false);

  function useMyLocation() {
    if (!navigator.geolocation) {
      setSearchError('This browser cannot share your location. Pick it on the map instead.');
      setShowMap(true);
      return;
    }
    setLocating(true);
    setSearchError('');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const picked = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        onChange(picked);
        setSearchedPosition(picked);
        try {
          onAddressResolved?.(await reverseGeocode(picked));
        } catch {
          setSearchError('Found you, but not your address. Please type it below.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setSearchError('Could not access your location. Pick it on the map instead.');
        setShowMap(true);
      }
    );
  }

  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError('');
    setResults([]);
    try {
      const url = `${NOMINATIM}/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.length === 0) {
        setSearchError('No matching locations found.');
      }
      setResults(data);
    } catch {
      setSearchError('Could not search right now. Please try again.');
    } finally {
      setSearching(false);
    }
  }

  function selectResult(result) {
    const picked = { lat: Number(result.lat), lng: Number(result.lon) };
    setSearchedPosition(picked);
    onChange(picked);
    onAddressResolved?.({
      address: formatAddress(result.address) || result.display_name,
      pincode: validPincode(result.address?.postcode)
    });
    setResults([]);
    setQuery(result.display_name);
  }

  // A tap on the map used to set coordinates only, leaving the address blank.
  async function pickPoint(latlng) {
    onChange(latlng);
    setSearchError('');
    try {
      onAddressResolved?.(await reverseGeocode(latlng));
    } catch {
      setSearchError('Could not find the address for that pin. Please type it below.');
    }
  }

  return (
    <div className="location-picker">
      <div className="location-actions">
        <button type="button" className="btn-add location-btn" onClick={useMyLocation} disabled={locating}>
          <Icon name="crosshair" size={18} />
          {locating ? 'Finding you…' : 'Use my location'}
        </button>
        <button type="button" className="btn-add location-btn" onClick={() => setShowMap((open) => !open)}>
          <Icon name={showMap ? 'close' : 'map'} size={18} />
          {showMap ? 'Hide map' : 'Pick on map'}
        </button>
      </div>

      {position && !showMap && (
        <p className="location-pinned">
          <Icon name="pin" size={16} />
          Pinned at {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
        </p>
      )}

      {showMap && (
        <div className="map-wrapper">
          <div className="location-search">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runSearch();
                }
              }}
              placeholder="Search for an area, street, or landmark"
            />
            <button type="button" onClick={runSearch} disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>

          {results.length > 0 && (
            <ul className="location-results">
              {results.map((result) => (
                <li key={result.place_id}>
                  <button type="button" onClick={() => selectResult(result)}>
                    {result.display_name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <MapContainer center={center} zoom={position ? 16 : 13} style={{ height: 280, width: '100%', borderRadius: 12 }}>
            <TileLayer
              attribution='&copy; OpenStreetMap contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <ClickHandler onPick={pickPoint} />
            <RecenterOnChange position={searchedPosition || position} />
            {position && <Marker position={position} icon={defaultIcon} />}
          </MapContainer>
          <p className="map-hint">Tap the map to move your delivery pin. Add flat number and landmark to the address above.</p>
        </div>
      )}

      {searchError && <p className="status-text error">{searchError}</p>}
    </div>
  );
}
