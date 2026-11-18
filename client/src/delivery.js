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

  const distanceKm = distanceFromKitchenKm(position.lat, position.lng, config);
  const tier = ladooTiers(config).find((entry) => entry.upToKm == null || distanceKm <= entry.upToKm);
  return Number(tier?.charge ?? 0);
}

// Distance bands for the ladoo delivery charge, as the server publishes them.
export function ladooTiers(config = {}) {
  if (Array.isArray(config.ladooDeliveryTiers) && config.ladooDeliveryTiers.length > 0) {
    return config.ladooDeliveryTiers;
  }
  return [
    { upToKm: Number(config.deliveryRadiusKm ?? 4), charge: 0 },
    { upToKm: null, charge: Number(config.ladooDeliveryCharge ?? 99) }
  ];
}

// "Free up to 5 km, ₹49 up to 10 km, ₹99 beyond."
export function ladooDeliveryNote(config = {}) {
  const tiers = ladooTiers(config);
  const parts = tiers.map((tier) => {
    const price = tier.charge > 0 ? `₹${tier.charge}` : 'free';
    return tier.upToKm == null ? `${price} beyond` : `${price} up to ${tier.upToKm} km`;
  });
  return `Dry Fruits Ladoo delivery: ${parts.join(', ')}.`;
}
