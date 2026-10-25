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

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  return n < 20 ? ONES[n] : [TENS[Math.floor(n / 10)], n % 10 ? ONES[n % 10] : ''].filter(Boolean).join(' ');
}

function belowThousand(n) {
  return [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? belowHundred(n % 100) : ''].filter(Boolean).join(' ');
}

/// Indian numbering (lakh, crore), as GST invoices state the amount.
function integerInWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  if (n >= 10000000) { parts.push(`${integerInWords(Math.floor(n / 10000000))} Crore`); n %= 10000000; }
  if (n >= 100000) { parts.push(`${belowHundred(Math.floor(n / 100000))} Lakh`); n %= 100000; }
  if (n >= 1000) { parts.push(`${belowHundred(Math.floor(n / 1000))} Thousand`); n %= 1000; }
  if (n > 0) parts.push(belowThousand(n));
  return parts.join(' ');
}

/// e.g. 314 -> "Rupees Three Hundred Fourteen Only".
export function rupeesInWords(amount) {
  const paise = Math.round(Number(amount) * 100);
  const rest = paise % 100;
  return [`Rupees ${integerInWords(Math.floor(paise / 100))}`, rest ? `and ${belowHundred(rest)} Paise` : '', 'Only']
    .filter(Boolean).join(' ');
}

export function paymentMode({ walletApplied = 0, amountPaid = 0 }) {
  if (walletApplied > 0) return amountPaid > 0 ? 'Wallet + UPI' : 'Wallet';
  return 'UPI';
}
