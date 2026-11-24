import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getHolidays, getMenu, getStoreConfig } from '../api';
import { useCart } from '../context/CartContext';
import BackToMenu from '../components/BackToMenu';
import { isMealPackage, isMonthlyPlan, isWeeklyPlan, isWorkWeekPlan, istToday } from '../mealPlans';
import {
  availableSingleMealServices,
  boxContents,
  closedDates,
  defaultWorkWeekMonday,
  holidayNote,
  isMondayDate,
  workWeekFor,
  workWeekPerDay,
  workWeekPrice,
  boxSlug,
  DAY_LONG,
  DAY_SHORT,
  defaultDayIndex,
  dishesFor,
  SECTIONS,
  WEEK_DAYS,
  planRulesNote
} from '../mealBoxes';
import { boxImage } from '../boxImages';

function planLabel(name) {
  const match = name.match(/\(([^)]+)\)/);
  return match ? match[1] : name;
}

function itemsFor(menu, section) {
  if (section === 'workweek') return menu.filter(isWorkWeekPlan);
  if (section === 'weekly') return menu.filter(isWeeklyPlan);
  if (section === 'monthly') return menu.filter(isMonthlyPlan);
  return menu.filter((item) => item.name.toLowerCase() === 'single meal');
}

export default function MealBox() {
  const { section, box: slug } = useParams();
  const meta = SECTIONS[section];
  const [menu, setMenu] = useState(null);
  const [holidays, setHolidays] = useState([]);
  const [monday, setMonday] = useState(null);
  const [mondayError, setMondayError] = useState('');
  const [storeConfig, setStoreConfig] = useState({ singleMealClosedToday: true });
  const [error, setError] = useState('');
  const [day, setDay] = useState(() => defaultDayIndex(meta?.days ?? 6));
  const [planId, setPlanId] = useState(null);
  const [service, setService] = useState(null);
  const [clock, setClock] = useState(() => Date.now());
  const { items: cart, addItem, changeStart, decreaseItem, makeKey, count, total } = useCart();

  useEffect(() => {
    getMenu().then(setMenu).catch(() => setError('Could not load the menu.'));
    getStoreConfig().then(setStoreConfig).catch(() => {});
    getHolidays().then(setHolidays).catch(() => {});
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
  const isWorkWeek = section === 'workweek';
  const closed = closedDates(holidays, storeConfig);
  // A plan already in the cart keeps its week until it's removed.
  const cartLine = cart.find((entry) => entry.id === item.id && entry.startDate);
  const week = isWorkWeek ? workWeekFor(cartLine?.startDate || monday || defaultWorkWeekMonday(istToday(), closed), closed) : null;
  const isPlan = isMealPackage(item);
  const startDate = week ? week.monday : cartLine?.startDate || monday || istToday();
  // Another plan in the cart: ask before adding this one too.
  const hasOtherPlan = cart.some((entry) => entry.id !== item.id && isMealPackage(entry));
  const fullPrice = variant?.price ?? item.price;
  const price = week ? workWeekPrice(fullPrice, week.days.length) : fullPrice;
  const per = (item.name.includes('+') ? 'day' : 'meal');
  function pickStart(value) {
    if (!value) return;
    if (value < istToday()) {
      setMondayError('Choose a start date from today onward.');
      return;
    }
    if (isWorkWeek && !isMondayDate(value)) {
      setMondayError('Work Week plans start on a Monday.');
      return;
    }
    if (isWorkWeek && workWeekFor(value, closed).days.length === 0) {
      setMondayError('The kitchen is closed all of that week. Choose another Monday.');
      return;
    }
    setMondayError('');
    if (cartLine) changeStart(cartLine.key, value, isWorkWeek ? workWeekFor(value, closed).days.length : undefined);
    else setMonday(value);
  }
  function add() {
    if (isPlan && quantity === 0 && hasOtherPlan && !window.confirm('You already have a subscription, do you still want to add?')) return;
    addItem(item, label, mealService, isPlan ? { startDate, ...(week ? { days: week.days.length } : {}) } : undefined);
  }
  const cannotAdd = storeConfig.orderingPaused || item.available === false || (week && week.days.length === 0) ||
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
      {planRulesNote(section) && <p className={section === 'monthly' ? 'plan-rules flexible' : 'plan-rules'}>{planRulesNote(section)}</p>}
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
        {['lunch', 'dinner'].map((name) => (
          <div key={name} className={`service-card service-${name}`}>
            <div className="service-card-head">
              <span className="service-card-name">{name === 'lunch' ? '☀️ Lunch' : '🌙 Dinner'}</span>
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
        <p className="menu-price">₹{price} / {week ? `${week.days.length} day${week.days.length === 1 ? '' : 's'}` : meta.unit}</p>
        {week && week.holidays.length > 0 && <p className="holiday-note">{holidayNote(week.holidays, fullPrice, workWeekPerDay(fullPrice), per)}</p>}
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
        {mondayError && <p className="status-text error">{mondayError}</p>}
        <div className="meal-box-actions">
          {isPlan && (
            <label className="start-date-chip">
              <span>{isWorkWeek ? 'Starts (Mon)' : 'Starts'}</span>
              <input type="date" value={startDate} min={istToday()} step={isWorkWeek ? 7 : undefined} onChange={(event) => pickStart(event.target.value)} />
            </label>
          )}
          {item.available === false ? <span className="status-text">Unavailable</span> : quantity === 0 ? (
            <button className="btn-add" disabled={cannotAdd} onClick={add}>Add</button>
          ) : (
            <div className="qty-control">
              <button onClick={() => decreaseItem(key)}>−</button>
              <span>{quantity}</span>
              <button disabled={cannotAdd} onClick={add}>+</button>
            </div>
          )}
          {count > 0 && <Link to="/checkout" className="meal-box-cart-link">{count} item{count > 1 ? 's' : ''} · ₹{total} · View Cart →</Link>}
        </div>
      </div>
    </div>
  );
}
