import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import 'leaflet/dist/leaflet.css';

// Fix default marker icon paths (Vite doesn't resolve them automatically)
const defaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});

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

  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError('');
    setResults([]);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=5&q=${encodeURIComponent(query)}`;
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
    onAddressResolved?.(result.display_name);
    setResults([]);
    setQuery(result.display_name);
  }

  return (
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
      {searchError && <p className="status-text error">{searchError}</p>}

      <MapContainer center={center} zoom={13} style={{ height: 280, width: '100%', borderRadius: 12 }}>
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onPick={onChange} />
        <RecenterOnChange position={searchedPosition} />
        {position && <Marker position={position} icon={defaultIcon} />}
      </MapContainer>
      <p className="map-hint">Search above or tap on the map to drop a pin at your delivery location.</p>
    </div>
  );
}
