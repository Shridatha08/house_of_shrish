import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import 'leaflet/dist/leaflet.css';
import { useAuth } from '../context/AuthContext';
import { trackOrder } from '../api';
import { etaText } from '../deadline';

const defaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41]
});

const POLL_MS = 15000;

export default function TrackOrder() {
  const { id } = useParams();
  const { token } = useAuth();
  const [params] = useSearchParams();
  const accessToken = params.get('token') || undefined;
  const [tracking, setTracking] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await trackOrder(id, token, accessToken);
        if (!cancelled) {
          setTracking(data);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, token, accessToken]);

  const driver = tracking?.driver;
  const hasFix = Boolean(driver?.lat != null && driver?.lng != null);
  const destination = tracking?.destination;

  return (
    <div className="track-page">
      <h1>Order #{id}</h1>
      <p className="status-text">{etaText(tracking)}</p>
      {error && <p className="status-text error">{error}</p>}

      {hasFix && (
        <MapContainer
          center={[driver.lat, driver.lng]}
          zoom={15}
          style={{ height: 320, borderRadius: 16 }}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Marker position={[driver.lat, driver.lng]} icon={defaultIcon} />
          {destination && (
            <>
              <Marker position={[destination.lat, destination.lng]} icon={defaultIcon} />
              <Polyline
                positions={[
                  [driver.lat, driver.lng],
                  [destination.lat, destination.lng]
                ]}
                pathOptions={{ color: '#e8552d', dashArray: '6 8' }}
              />
            </>
          )}
        </MapContainer>
      )}

      {driver?.name && (
        <div className="track-driver">
          <strong>{driver.name}</strong>
          {driver.phone && <a className="btn-link" href={`tel:${driver.phone}`}>Call</a>}
        </div>
      )}

      <p className="no-print">
        <Link to="/profile">Back to my orders</Link>
      </p>
    </div>
  );
}
