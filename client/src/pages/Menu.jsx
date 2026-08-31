import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMenu } from '../api';
import { useCart } from '../context/CartContext';
import fssaiLogo from '../../../fssai.png';
import mealsImg from '../../../meals.png';
import chocolateImg from '../../../chocolate.png';
import phoneIcon from '../../../phone-call.png';
import whatsappIcon from '../../../whatsapp.png';
import instagramIcon from '../../../instagram.png';
import goGreenIcon from '../../../go-green.png';

const CATEGORY_BANNERS = {
  'Pure Veg Meals': mealsImg,
  'Artisanal Chocolates': chocolateImg
};

// Extracts the "Lunch" / "Dinner" / "Lunch + Dinner" part from a name like "Monthly (Lunch)".
function planLabel(name) {
  const match = name.match(/\(([^)]+)\)/);
  return match ? match[1] : name;
}

function CustomisationPicker({ item, selected, onSelect, hideLabel }) {
  return (
    <div className="customisation-group">
      {!hideLabel && <span className="customisation-label">Choose your meal</span>}
      <div className="customisation-options">
        {item.customisations.map((option, idx) => (
          <button
            key={option}
            type="button"
            className={selected === option ? 'customisation-pill active' : 'customisation-pill'}
            onClick={() => onSelect(option)}
          >
            <span className="customisation-pill-title">Option {idx + 1}</span>
            <span className="customisation-pill-desc">{option}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Menu() {
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedCustomisation, setSelectedCustomisation] = useState({}); // { [menuItemId]: customisation }
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const { items, addItem, decreaseItem, total, count, makeKey } = useCart();

  useEffect(() => {
    getMenu()
      .then(setMenu)
      .catch(() => setError('Could not load the menu. Is the server running?'))
      .finally(() => setLoading(false));
  }, []);

  function customisationFor(item) {
    if (!item.customisations?.length) return undefined;
    return selectedCustomisation[item.id] ?? item.customisations[0];
  }

  const quantityOf = (item) => {
    const key = makeKey(item.id, customisationFor(item));
    return items.find((i) => i.key === key)?.quantity || 0;
  };

  if (loading) return <p className="status-text">Loading menu…</p>;
  if (error) return <p className="status-text error">{error}</p>;

  const categories = [...new Set(menu.map((m) => m.category))];

  return (
    <div className="menu-page">
      <section className="hero">
        <h1>Home-style Pure Veg Meals, Delivered Fresh</h1>
        <p>Wholesome thalis, monthly meal plans &amp; handcrafted chocolates — made with care, served with love.</p>
        <div className="hero-stats">
          <div className="hero-stat">
            <strong>100%</strong>
            <span>Pure Veg</span>
          </div>
          <div className="hero-stat">
            <strong>Bio-degradable</strong>
            <span>Packaging</span>
          </div>
          <div className="hero-stat">
            <strong>Fresh</strong>
            <span>Made Daily</span>
          </div>
        </div>
      </section>

      <div className="announcement-banner">
        Kitchen closed from Sep 12-16
      </div>

      {categories.map((category) => {
        const categoryItems = menu.filter((item) => item.category === category);
        const monthlyPlans = categoryItems.filter((item) => item.name.toLowerCase().startsWith('monthly'));
        const regularItems = categoryItems.filter((item) => !item.name.toLowerCase().startsWith('monthly'));
        const selectedPlan = monthlyPlans.find((p) => p.id === selectedPlanId) || monthlyPlans[0];

        return (
          <section key={category} className="menu-category">
            <h2>{category}</h2>
            {CATEGORY_BANNERS[category] && (
              <img src={CATEGORY_BANNERS[category]} alt={category} className="category-banner" />
            )}
            <div className="menu-grid">
              {regularItems.map((item) => (
                <div key={item.id} className="menu-card">
                  <div className="menu-card-body">
                    <div className="menu-card-heading">
                      <span className="veg-badge" title="Pure Veg" />
                      <h3>{item.name}</h3>
                    </div>
                    <p className="menu-desc">{item.description}</p>
                    <p className="menu-price">₹{item.price}</p>
                    {item.customisations?.length > 0 && (
                      <CustomisationPicker
                        item={item}
                        selected={customisationFor(item)}
                        onSelect={(option) =>
                          setSelectedCustomisation((prev) => ({ ...prev, [item.id]: option }))
                        }
                      />
                    )}
                  </div>
                  <div className="menu-card-actions">
                    {quantityOf(item) === 0 ? (
                      <button className="btn-add" onClick={() => addItem(item, customisationFor(item))}>
                        Add
                      </button>
                    ) : (
                      <div className="qty-control">
                        <button onClick={() => decreaseItem(makeKey(item.id, customisationFor(item)))}>−</button>
                        <span>{quantityOf(item)}</span>
                        <button onClick={() => addItem(item, customisationFor(item))}>+</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {selectedPlan && (
                <div className="menu-card monthly-package-card">
                  <div className="menu-card-body">
                    <div className="menu-card-heading">
                      <span className="veg-badge" title="Pure Veg" />
                      <h3>Monthly Package</h3>
                    </div>
                    <p className="menu-desc">Choose Lunch, Dinner, or both for the whole month.</p>

                    <div className="customisation-group">
                      <span className="customisation-label">Step 1 · Choose a plan</span>
                      <div className="customisation-options">
                        {monthlyPlans.map((plan) => (
                          <button
                            key={plan.id}
                            type="button"
                            className={plan.id === selectedPlan.id ? 'customisation-pill active' : 'customisation-pill'}
                            onClick={() => setSelectedPlanId(plan.id)}
                          >
                            <span className="customisation-pill-title">{planLabel(plan.name)}</span>
                            <span className="customisation-pill-desc">₹{plan.price} / month</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {selectedPlan.customisations?.length > 0 && (
                      <div className="step-2">
                        <span className="customisation-label">Step 2 · Choose your meal</span>
                        <CustomisationPicker
                          item={selectedPlan}
                          selected={customisationFor(selectedPlan)}
                          hideLabel
                          onSelect={(option) =>
                            setSelectedCustomisation((prev) => ({ ...prev, [selectedPlan.id]: option }))
                          }
                        />
                      </div>
                    )}

                    <p className="menu-price">₹{selectedPlan.price}</p>
                  </div>
                  <div className="menu-card-actions">
                    {quantityOf(selectedPlan) === 0 ? (
                      <button className="btn-add" onClick={() => addItem(selectedPlan, customisationFor(selectedPlan))}>
                        Add
                      </button>
                    ) : (
                      <div className="qty-control">
                        <button onClick={() => decreaseItem(makeKey(selectedPlan.id, customisationFor(selectedPlan)))}>−</button>
                        <span>{quantityOf(selectedPlan)}</span>
                        <button onClick={() => addItem(selectedPlan, customisationFor(selectedPlan))}>+</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}

      <footer className="site-footer">
        <div className="delivery-info">
          <p className="delivery-info-title">✦ Free Door Delivery ✦</p>
          <p className="delivery-info-note">
            [Applicable to Malleshpalya and Kaggadasapura, else delivery charges applicable]
          </p>
        </div>

        <p className="eco-text">
          Your food is thoughtfully served in bio-degradable packaging - caring for you and nature
          <img src={goGreenIcon} alt="Go Green" className="eco-icon" />
        </p>

        <div className="contact-section">
          <p>We also undertake bulk order for corporate and house events</p>
          <p>For enquiries contact us at</p>
          <p className="contact-row">
            <img src={phoneIcon} alt="Phone" className="contact-icon" />
            +91 9180381854
          </p>
          <p className="contact-row">
            <img src={whatsappIcon} alt="WhatsApp" className="contact-icon" />
            <a href="https://wa.me/+919180381854" target="_blank" rel="noopener noreferrer">
              +91 9180381854
            </a>
          </p>
          <p className="contact-row">
            <img src={instagramIcon} alt="Instagram" className="contact-icon" />
            <a href="https://www.instagram.com/house_of_shrish" target="_blank" rel="noopener noreferrer">
              Instagram
            </a>
          </p>
        </div>

        <div className="fssai-section">
          <img src={fssaiLogo} alt="FSSAI" className="fssai-logo" />
          <p className="fssai-text">Lic no. 21226187002762</p>
        </div>
      </footer>

      {count > 0 && (
        <Link to="/checkout" className="cart-bar">
          <span>{count} item{count > 1 ? 's' : ''} in cart</span>
          <span>₹{total} · View Cart →</span>
        </Link>
      )}
    </div>
  );
}
