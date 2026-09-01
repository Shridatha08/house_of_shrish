import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getInvoice } from '../api';

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Invoice() {
  const { id } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getInvoice(id)
      .then(setInvoice)
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) return <p className="status-text error">{error}</p>;
  if (!invoice) return <p className="status-text">Loading invoice…</p>;

  return (
    <div className="invoice-page">
      <Link to="/" className="btn-link back-link no-print">‹ Back to Menu</Link>

      <div className="invoice-card">
        <div className="invoice-header">
          <div>
            <h2>{invoice.business.name}</h2>
            <p>{invoice.business.address}</p>
          </div>
          <div className="invoice-meta">
            <p><strong>Invoice No:</strong> {invoice.invoiceNumber}</p>
            <p><strong>Order No:</strong> #{invoice.orderNumber}</p>
            <p><strong>Date:</strong> {formatDate(invoice.date)}</p>
          </div>
        </div>

        <div className="invoice-customer">
          <p><strong>Billed to:</strong> {invoice.customer.name}</p>
          <p>{invoice.customer.address}</p>
          <p>Phone: {invoice.customer.phone}</p>
        </div>

        <table className="invoice-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Total (₹)</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item, idx) => (
              <tr key={idx}>
                <td>
                  {item.name}
                  {item.customisation && <span className="invoice-item-note">{item.customisation}</span>}
                </td>
                <td>{item.quantity}</td>
                <td>{item.lineTotal.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="invoice-totals">
          <div className="invoice-totals-row invoice-grand-total">
            <strong>Total</strong>
            <strong>₹{invoice.total.toFixed(2)}</strong>
          </div>
        </div>

        <p className="invoice-footnote">This is a computer-generated invoice.</p>
      </div>

      <button className="btn-primary no-print" onClick={() => window.print()}>Print / Save as PDF</button>
    </div>
  );
}
