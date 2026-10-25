import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import BackToMenu from '../components/BackToMenu';
import { getInvoice } from '../api';
import { useAuth } from '../context/AuthContext';

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Invoice() {
  const { id } = useParams();
  const location = useLocation();
  const { token, ready } = useAuth();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setError('');
    setInvoice(null);
    getInvoice(id, token, location.state?.accessToken || sessionStorage.getItem(`orderAccess:${id}`))
      .then((result) => { if (!cancelled) setInvoice(result); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [id, token, ready, location.state]);

  if (error) return <p className="status-text error">{error}</p>;
  if (!invoice) return <p className="status-text">Loading invoice…</p>;

  const money = (value) => Number(value || 0).toFixed(2);
  const taxInvoice = invoice.taxInvoice === true;

  return (
    <div className="invoice-page">
      <BackToMenu className="no-print" />

      <div className="invoice-card">
        <p className="invoice-title">{taxInvoice ? 'Tax Invoice' : 'Invoice'}</p>
        <div className="invoice-header">
          <div>
            <h2>{invoice.business.name}</h2>
            <p>{invoice.business.address}</p>
            {invoice.business.gstin && <p><strong>GSTIN:</strong> {invoice.business.gstin}</p>}
          </div>
          <div className="invoice-meta">
            <p><strong>Invoice No:</strong> {invoice.invoiceNumber}</p>
            <p><strong>Invoice Date:</strong> {formatDate(invoice.date)}</p>
            <p><strong>Order No:</strong> #{invoice.orderNumber}</p>
            <p><strong>Status:</strong> {invoice.status?.replaceAll('_', ' ')}</p>
            <p><strong>Delivery:</strong> {invoice.scheduledDate ? `${invoice.scheduledDate} · ${invoice.timeSlot}` : 'No scheduled delivery'}</p>
          </div>
        </div>

        <div className="invoice-customer">
          <p><strong>Billed to:</strong> {invoice.customer.name}</p>
          {invoice.customer.flatNumber && <p>Flat / Door: {invoice.customer.flatNumber}</p>}
          <p>{invoice.customer.address}</p>
          {invoice.customer.pincode && <p>Pincode: {invoice.customer.pincode}</p>}
          <p>Phone: {invoice.customer.phone}</p>
        </div>

        <table className="invoice-table">
          <thead>
            <tr>
              <th>Item</th>
              {taxInvoice && <th>HSN/SAC</th>}
              <th>Qty</th>
              <th>Rate (₹)</th>
              <th>{taxInvoice ? 'Taxable value (₹)' : 'Total (₹)'}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, idx) => (
              <tr key={idx}>
                <td>
                  {item.name}
                  {item.customisation && <span className="invoice-item-note">{item.customisation}</span>}
                </td>
                {taxInvoice && <td>{invoice.hsn}</td>}
                <td>{item.quantity}</td>
                <td>{money(item.price)}</td>
                <td>{money(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="invoice-totals">
          {taxInvoice && (
            <>
              <div className="invoice-totals-row">
                <span>Taxable value</span>
                <span>₹{money(invoice.taxableValue)}</span>
              </div>
              <div className="invoice-totals-row">
                <span>CGST @ {invoice.cgstRate}%</span>
                <span>₹{money(invoice.cgst)}</span>
              </div>
              <div className="invoice-totals-row">
                <span>SGST @ {invoice.sgstRate}%</span>
                <span>₹{money(invoice.sgst)}</span>
              </div>
              {invoice.roundOff > 0 && (
                <div className="invoice-totals-row">
                  <span>Round off</span>
                  <span>+₹{money(invoice.roundOff)}</span>
                </div>
              )}
            </>
          )}
          <div className="invoice-totals-row invoice-grand-total">
            <strong>{taxInvoice ? 'Invoice total' : 'Total'}</strong>
            <strong>₹{money(invoice.total)}</strong>
          </div>
          {invoice.walletApplied > 0 && (
            <>
              <div className="invoice-totals-row">
                <span>Paid from wallet</span>
                <span>₹{money(invoice.walletApplied)}</span>
              </div>
              {invoice.amountPaid > 0 && (
                <div className="invoice-totals-row">
                  <span>Paid by UPI</span>
                  <span>₹{money(invoice.amountPaid)}</span>
                </div>
              )}
            </>
          )}
        </div>

        {taxInvoice && (
          <p className="invoice-footnote">
            Supply of restaurant services (SAC {invoice.hsn}), intra-state, Karnataka. Tax not payable under reverse charge.
          </p>
        )}
        <p className="invoice-footnote">This is a computer-generated invoice and needs no signature.</p>
      </div>

      <button className="btn-primary no-print" onClick={() => window.print()}>Print / Save as PDF</button>
    </div>
  );
}
