/// Mirrors the server's gstBreakdown so checkout shows exactly what the order
/// will be charged. Menu prices are exclusive of GST; work is in whole paise.
export const GSTIN = '29LXJPS8316L1ZC';
export const RESTAURANT_HSN = '9963';
export const CGST_RATE = 2.5;
export const SGST_RATE = 2.5;

export function gstBreakdown(taxableValue) {
  const basePaise = Math.round(Number(taxableValue) * 100);
  const cgstPaise = Math.round((basePaise * CGST_RATE) / 100);
  const sgstPaise = Math.round((basePaise * SGST_RATE) / 100);
  const grossPaise = basePaise + cgstPaise + sgstPaise;
  // Rounded up to the next whole rupee, as the server charges.
  const totalPaise = Math.ceil(grossPaise / 100) * 100;
  return {
    taxableValue: basePaise / 100,
    cgst: cgstPaise / 100,
    sgst: sgstPaise / 100,
    roundOff: (totalPaise - grossPaise) / 100,
    total: totalPaise / 100
  };
}

/// Whole rupees stay whole; anything with paise always shows two decimals.
export function formatRupees(value) {
  const amount = Number(value) || 0;
  return `₹${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}
