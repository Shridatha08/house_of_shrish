export function distanceFromKitchenKm(lat, lng, config = {}) {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const kitchenLat = Number(config.kitchenLat ?? 12.9744129);
  const kitchenLng = Number(config.kitchenLng ?? 77.6743533);
  const earthRadiusKm = 6371;
  const dLat = toRad(lat - kitchenLat);
  const dLng = toRad(lng - kitchenLng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(kitchenLat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function dryFruitsLadooDeliveryCharge(items, position, config = {}) {
  const containsLadoo = items.some(
    (item) => String(item.name || '').trim().toLowerCase() === 'dry fruits ladoo'
  );
  if (!containsLadoo || !position ||
      !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return 0;

  const radiusKm = Number(config.deliveryRadiusKm ?? 4);
  return distanceFromKitchenKm(position.lat, position.lng, config) > radiusKm
    ? Number(config.ladooDeliveryCharge ?? 99)
    : 0;
}
