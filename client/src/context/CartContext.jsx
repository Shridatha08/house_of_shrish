import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const CartContext = createContext(null);

function makeKey(id, customisation) {
  return `${id}::${customisation || ''}`;
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('houseOfShrishCart') || '[]');
      return Array.isArray(saved) ? saved.filter((item) => typeof item.name === 'string' && typeof item.key === 'string' && Number.isFinite(item.price) && Number.isInteger(item.quantity) && item.quantity > 0) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    sessionStorage.setItem('houseOfShrishCart', JSON.stringify(items));
  }, [items]);

  function addItem(menuItem, customisation) {
    const key = makeKey(menuItem.id, customisation);
    const variant = menuItem.variants?.find((option) => option.label === customisation);
    const price = variant?.price ?? menuItem.price;
    setItems((prev) => {
      if (menuItem.name.toLowerCase().startsWith('monthly') && prev.some((item) => item.id === menuItem.id)) return prev;
      const existing = prev.find((i) => i.key === key);
      if (existing) {
        return prev.map((i) =>
          i.key === key ? { ...i, quantity: Math.min(50, i.quantity + 1) } : i
        );
      }
      return [
        ...prev,
        { key, id: menuItem.id, name: menuItem.name, price, quantity: 1, customisation: customisation || '' }
      ];
    });
  }

  function decreaseItem(key) {
    setItems((prev) =>
      prev
        .map((i) => (i.key === key ? { ...i, quantity: i.quantity - 1 } : i))
        .filter((i) => i.quantity > 0)
    );
  }

  function removeItem(key) {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }

  function clearCart() {
    setItems([]);
  }

  const total = useMemo(() => items.reduce((sum, i) => sum + i.price * i.quantity, 0), [items]);
  const count = useMemo(() => items.reduce((sum, i) => sum + i.quantity, 0), [items]);

  const value = { items, addItem, decreaseItem, removeItem, clearCart, total, count, makeKey };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
}
