import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getMenu, getStoreConfig } from '../api';
import { useCart } from '../context/CartContext';
import BackToMenu from '../components/BackToMenu';
import { isMealPackage, isMonthlyPlan, isWeeklyPlan } from '../mealPlans';
import {
  availableSingleMealServices,
  boxContents,
  boxImage,
  boxSlug,
  DAY_LONG,
  DAY_SHORT,
  defaultDayIndex,
  deliveryWindow,
  dishesFor,
  SECTIONS,
  WEEK_DAYS
} from '../mealBoxes';

function planLabel(name) {
  const match = name.match(/\(([^)]+)\)/);
  return match ? match[1] : name;
}

function itemsFor(menu, section) {
  if (section === 'weekly') return menu.filter(isWeeklyPlan);
  if (section === 'monthly') return menu.filter(isMonthlyPlan);
  return menu.filter((item) => item.name.toLowerCase() === 'single meal');
}

export default function MealBox() {
  const { section, box: slug } = useParams();
  const meta = SECTIONS[section];
  const [menu, setMenu] = useState(null);
  const [storeConfig, setStoreConfig] = useState({ singleMealClosedToday: true });
  const [error, setError] = useState('');
  const [day, setDay] = useState(() => defaultDayIndex(meta?.days ?? 6));
  const [planId, setPlanId] = useState(null);
  const [service, setService] = useState(null);
  const [clock, setClock] = useState(() => Date.now());
  const { items: cart, addItem, decreaseItem, makeKey, count, total } = useCart();

  useEffect(() => {
    getMenu().then(setMenu).catch(() => setError('Could not load the menu.'));
    getStoreConfig().then(setStoreConfig).catch(() => {});
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <p className="status-text error">{error}</p>;
  if (!menu) return <p className="status-text">Loading…</p>;

  const plans = meta ? itemsFor(menu, section) : [];
  const label = plans[0]?.variants?.find((variant) => boxSlug(variant.label) === slug)?.label;
  if (!meta || !label) {
    return (
      <div className="meal-box-page">
        <BackToMenu />
        <p className="status-text">That meal box is no longer on the menu.</p>
      </div>
    );
  }

  const isSingle = section === 'single';
  const item = plans.find((plan) => plan.id === planId) || plans[0];
  const variant = item.variants.find((entry) => entry.label === label);
  const services = isSingle ? availableSingleMealServices(storeConfig, new Date(clock)) : [];
  const mealService = isSingle ? (services.includes(service) ? service : services[0]) : undefined;
  const key = makeKey(item.id, label, mealService);
  const quantity = cart.find((entry) => entry.key === key)?.quantity || 0;
  const inCart = cart.filter((entry) => entry.id === item.id).reduce((sum, entry) => sum + entry.quantity, 0);
  const cannotAdd = storeConfig.orderingPaused || item.available === false ||
    (item.remainingStock != null && inCart >= item.remainingStock) ||
    (isSingle && !mealService) ||
    (isMealPackage(item) && inCart >= 1);
  const contents = boxContents(storeConfig, label);
  const image = boxImage(label);

  return (
    <div className="meal-box-page">
      <BackToMenu />
      <div className="meal-box-hero">
        {image ? <img src={image} alt={label} /> : <div className="meal-box-placeholder" aria-hidden="true">🍱</div>}
      </div>

      <h1 className="meal-box-title">{label}</h1>
      <p className="meal-box-section">{meta.title}{meta.note ? ` · ${meta.note}` : ''}</p>
      {variant?.description && <p className="menu-desc">{variant.description}</p>}

      <p className="meal-box-kicker">Choose day to preview</p>
      <div className="meal-box-days">
        {DAY_SHORT.slice(0, meta.days).map((name, index) => (
          <button key={name} type="button" className={index === day ? 'day-chip active' : 'day-chip'} onClick={() => setDay(index)}>
            {name}
          </button>
        ))}
      </div>

      <h2 className="meal-box-day-title"><span className="veg-dot" />{DAY_LONG[day]}&apos;s Menu</h2>
      <div className="meal-box-services">
        {['lunch', 'dinner'].map((name, index) => (
          <div key={name} className={`service-card service-${name}`}>
            <div className="service-card-head">
              <span className="service-card-name">{name === 'lunch' ? '☀️ Lunch' : '🌙 Dinner'}</span>
              {deliveryWindow(storeConfig.deliveryTimeSlots, index) && (
                <span className="service-card-time">{deliveryWindow(storeConfig.deliveryTimeSlots, index)}</span>
              )}
            </div>
            <p className="meal-box-kicker">Main course</p>
            {dishesFor(storeConfig, label, WEEK_DAYS[day], name).map((dish) => (
              <div key={dish.kind} className="dish-row">
                <span className="veg-badge" title="Pure Veg" />
                {dish.name ? <strong>{dish.name}</strong> : <span className="dish-pending">{dish.title} · to be announced</span>}
              </div>
            ))}
            {contents.fixedItems.length > 0 && (
              <>
                <p className="meal-box-kicker">Served with</p>
                <div className="fixed-items">
                  {contents.fixedItems.map((fixed) => <span key={fixed} className="fixed-item">{fixed}</span>)}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="meal-box-order">
        <p className="menu-price">₹{variant?.price ?? item.price} / {meta.unit}</p>
        {isSingle ? (
          services.length === 0 ? (
            <p className="status-text error">
              {storeConfig.singleMealClosedToday
                ? 'Single Meal is unavailable on Sundays and kitchen holidays.'
                : 'Single Meal ordering is closed for today.'}
            </p>
          ) : (
            <div className="customisation-options row">
              {services.map((name) => (
                <button key={name} type="button" className={name === mealService ? 'customisation-pill active' : 'customisation-pill'} onClick={() => setService(name)}>
                  <span className="customisation-pill-title">{name[0].toUpperCase() + name.slice(1)}</span>
                  <span className="customisation-pill-desc">{name === 'lunch' ? storeConfig.lunchCutoffTime || '11:00' : storeConfig.dinnerCutoffTime || '18:00'} IST cutoff</span>
                </button>
              ))}
            </div>
          )
        ) : (
          <div className="customisation-options row">
            {plans.map((plan) => (
              <button key={plan.id} type="button" className={plan.id === item.id ? 'customisation-pill active' : 'customisation-pill'} onClick={() => setPlanId(plan.id)}>
                <span className="customisation-pill-title">{planLabel(plan.name)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="meal-box-actions">
          {item.available === false ? <span className="status-text">Unavailable</span> : quantity === 0 ? (
            <button className="btn-add" disabled={cannotAdd} onClick={() => addItem(item, label, mealService)}>Add</button>
          ) : (
            <div className="qty-control">
              <button onClick={() => decreaseItem(key)}>−</button>
              <span>{quantity}</span>
              <button disabled={cannotAdd} onClick={() => addItem(item, label, mealService)}>+</button>
            </div>
          )}
          {count > 0 && <Link to="/checkout" className="meal-box-cart-link">{count} item{count > 1 ? 's' : ''} · ₹{total} · View Cart →</Link>}
        </div>
      </div>
    </div>
  );
}
