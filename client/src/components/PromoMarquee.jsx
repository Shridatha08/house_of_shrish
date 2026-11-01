import { useEffect, useRef, useState } from 'react';

const promos = [
  {
    image: '/promo/subscription-flexibility.jpg',
    alt: 'Flexible meal subscriptions: pause, skip, restart, and carry meals forward.'
  },
  {
    image: '/promo/home-comfort.jpg',
    alt: 'Comforting home-style meals delivered fresh.'
  },
  {
    image: '/promo/sustainable-packaging.jpg',
    alt: 'Meals packed in biodegradable, plastic-free packaging.'
  },
  {
    image: '/promo/balanced-meals.jpg',
    alt: 'Thoughtfully balanced meals for every day.'
  },
  {
    image: '/promo/better-oils.jpg',
    alt: 'Air-fried food prepared with virgin olive or coconut oil.'
  },
  {
    image: '/promo/homestyle-honest.jpg',
    alt: 'Homestyle meals made without soda, maida, or preservatives.'
  },
  {
    image: '/promo/busy-day-meals.jpg',
    alt: 'Fresh meals for busy workdays and tight schedules.'
  }
];

export default function PromoMarquee() {
  const viewportRef = useRef(null);
  const activeIndex = useRef(0);
  const [activePromo, setActivePromo] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const timer = window.setInterval(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      const next = (activeIndex.current + 1) % (promos.length * 2);
      if (next === 0) {
        viewport.scrollTo({ left: 0, behavior: 'instant' });
        activeIndex.current = 0;
        setActivePromo(0);
        return;
      }

      const card = viewport.firstElementChild?.children[next];
      if (!card) return;
      activeIndex.current = next;
      setActivePromo(next % promos.length);
      viewport.scrollTo({
        left: card.offsetLeft - (viewport.clientWidth - card.clientWidth) / 2,
        behavior: 'smooth'
      });
    }, 4500);

    return () => window.clearInterval(timer);
  }, [paused]);

  function showPromo(index) {
    const viewport = viewportRef.current;
    const card = viewport?.firstElementChild?.children[index];
    if (!viewport || !card) return;
    activeIndex.current = index;
    setActivePromo(index % promos.length);
    viewport.scrollTo({
      left: card.offsetLeft - (viewport.clientWidth - card.clientWidth) / 2,
      behavior: 'smooth'
    });
  }

  function updateActivePromo() {
    const viewport = viewportRef.current;
    const cards = viewport?.firstElementChild?.children;
    if (!viewport || !cards) return;
    const viewportCenter = viewport.getBoundingClientRect().left + viewport.clientWidth / 2;
    let nearestIndex = activeIndex.current;
    let nearestDistance = Infinity;

    for (let index = 0; index < cards.length; index++) {
      const bounds = cards[index].getBoundingClientRect();
      const distance = Math.abs(bounds.left + bounds.width / 2 - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }

    activeIndex.current = nearestIndex;
    setActivePromo(nearestIndex % promos.length);
  }

  return (
    <section
      className="promo-marquee"
      aria-label="House of Shrish highlights"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <div className="promo-marquee-viewport" ref={viewportRef} onScroll={updateActivePromo}>
        <div className="promo-marquee-track">
          {[...promos, ...promos].map((promo, index) => (
            <div className="promo-marquee-card" key={`${promo.image}-${index}`}>
              <img src={promo.image} alt={index < promos.length ? promo.alt : ''} />
            </div>
          ))}
        </div>
      </div>
      <div className="promo-marquee-dots" aria-label="Choose a highlight">
        {promos.map((promo, index) => (
          <button
            key={promo.image}
            type="button"
            className={index === activePromo ? 'active' : ''}
            aria-label={`Show highlight ${index + 1}`}
            aria-current={index === activePromo ? 'true' : undefined}
            onClick={() => showPromo(index)}
          />
        ))}
      </div>
    </section>
  );
}
