import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Zap, ShoppingCart, Search, Plus, Minus, Trash2, ArrowLeft, Printer,
  PauseCircle, PlayCircle, Check, CreditCard, Banknote, QrCode, Clock,
  User, Phone, X, AlertCircle, Share2, FileText, ChevronRight, HelpCircle,
  RotateCcw, Sparkles, Tag, Layers
} from 'lucide-react';
import QRCode from 'qrcode';
import {
  getAllProducts, saveProduct, getAllClients, saveClient, saveBill,
  getProfile, getNextInvoiceNumber, applyStockChanges, getStockAlertSettings
} from '../store';
import {
  formatCurrency, computeInvoiceTotals, localToday, INVOICE_TYPES,
  stockEffect, stockDelta, businessKeyOf
} from '../utils';
import { getPrintSettings } from '../utils/printSettings';
import { openWhatsAppShare } from '../utils/share';
import { toast } from './Toast';

// Audio beeper using Web Audio API (mimics barcode scanners & POS terminals)
function playBeep(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.frequency.setValueAtTime(880, ctx.currentTime); // High pleasant beep
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);
    } else if (type === 'add') {
      osc.frequency.setValueAtTime(1046.5, ctx.currentTime); // C6 note
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
    } else if (type === 'hold') {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } else {
      osc.frequency.setValueAtTime(220, ctx.currentTime); // Low error buzz
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    }
  } catch {
    // AudioContext blocked or not supported
  }
}

export default function PosBilling({ activeProfile, onBack, onOpenSettings }) {
  const [profile, setProfile] = useState(activeProfile || null);
  const [products, setProducts] = useState([]);
  const [clients, setClients] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [cart, setCart] = useState([]);
  const [invoiceType, setInvoiceType] = useState('tax-invoice'); // 'tax-invoice' | 'bill-of-supply'
  const [taxInclusive, setTaxInclusive] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [paymentMode, setPaymentMode] = useState('cash'); // 'cash' | 'upi' | 'card' | 'credit'
  const [tenderedAmount, setTenderedAmount] = useState('');
  const [billDiscount, setBillDiscount] = useState({ value: 0, type: 'fixed' });
  const [isProcessing, setIsProcessing] = useState(false);
  const [upiQrUrl, setUpiQrUrl] = useState('');

  // Customer selection
  const [selectedClient, setSelectedClient] = useState({
    name: 'Cash / Walk-in Customer',
    phone: '',
    gstin: '',
    state: ''
  });
  const [showClientModal, setShowClientModal] = useState(false);
  const [clientSearch, setClientSearch] = useState('');

  // Held Bills (stored in localStorage)
  const [heldBills, setHeldBills] = useState(() => {
    try {
      const saved = localStorage.getItem('gst_pos_held_bills');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [showHeldModal, setShowHeldModal] = useState(false);

  // Print Slip Modal after sale
  const [completedSale, setCompletedSale] = useState(null);
  const [showSlipModal, setShowSlipModal] = useState(false);

  const barcodeInputRef = useRef(null);

  // Load initial data
  useEffect(() => {
    if (!profile) {
      getProfile().then(p => {
        setProfile(p);
        if (p?.state) setSelectedClient(c => ({ ...c, state: p.state }));
      }).catch(() => {});
    }
    loadData();
    refreshNextInvoiceNumber();
  }, []);

  const loadData = async () => {
    try {
      const [allProds, allClis] = await Promise.all([
        getAllProducts(),
        getAllClients()
      ]);
      setProducts(allProds || []);
      setClients(allClis || []);
    } catch (err) {
      console.error('Failed to load POS data', err);
    }
  };

  const refreshNextInvoiceNumber = async () => {
    try {
      const nextNum = await getNextInvoiceNumber('INV', {
        peek: true,
        invoiceType,
        businessKey: businessKeyOf(profile)
      });
      setInvoiceNumber(nextNum);
    } catch (err) {
      setInvoiceNumber(`INV-${Date.now().toString().slice(-4)}`);
    }
  };

  // Derive categories from products
  const categories = useMemo(() => {
    const cats = new Set();
    products.forEach(p => {
      if (p.category) cats.add(p.category);
    });
    return Array.from(cats);
  }, [products]);

  // Filtered products for the catalog
  const filteredProducts = useMemo(() => {
    let list = products;
    if (selectedCategory !== 'all') {
      list = list.filter(p => p.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.hsn || '').toLowerCase().includes(q) ||
        (p.barcode || '').toLowerCase().includes(q) ||
        (p.itemCode || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [products, selectedCategory, searchQuery]);

  // Calculate Invoice Totals via the standard engine
  const totals = useMemo(() => {
    return computeInvoiceTotals({
      items: cart,
      profile: profile || {},
      client: {
        name: selectedClient.name,
        state: selectedClient.state || profile?.state || '',
        gstin: selectedClient.gstin || '',
        country: 'India'
      },
      details: { placeOfSupply: selectedClient.state || profile?.state || '' },
      showGST: invoiceType === 'tax-invoice',
      taxInclusive: !!taxInclusive,
      invoiceOptions: {
        invoiceDiscount: billDiscount.value ? billDiscount : null
      }
    });
  }, [cart, profile, selectedClient, invoiceType, taxInclusive, billDiscount]);

  // Generate dynamic UPI QR Code when total changes or UPI mode selected
  useEffect(() => {
    if (paymentMode === 'upi' && profile?.upiId && totals.total > 0) {
      const upiUrl = `upi://pay?pa=${encodeURIComponent(profile.upiId)}&pn=${encodeURIComponent(profile.businessName || 'POS')}&am=${totals.total.toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Bill ${invoiceNumber || 'POS'}`)}`;
      QRCode.toDataURL(upiUrl, { width: 180, margin: 1, errorCorrectionLevel: 'M' })
        .then(setUpiQrUrl)
        .catch(() => setUpiQrUrl(''));
    } else {
      setUpiQrUrl('');
    }
  }, [paymentMode, profile?.upiId, profile?.businessName, totals.total, invoiceNumber]);

  // Focus barcode input on mount and keep it focused
  useEffect(() => {
    barcodeInputRef.current?.focus();
  }, []);

  // Save held bills to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('gst_pos_held_bills', JSON.stringify(heldBills));
    } catch {}
  }, [heldBills]);

  // Global Keyboard Shortcuts (Vyapar standard)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't intercept shortcuts when editing client modal is open
      if (showClientModal) return;

      if (e.key === 'F1') {
        e.preventDefault();
        barcodeInputRef.current?.focus();
        barcodeInputRef.current?.select();
      } else if (e.key === 'F2') {
        e.preventDefault();
        handleSaveSale({ printSlip: true });
      } else if (e.key === 'F4') {
        e.preventDefault();
        handleHoldBill();
      } else if (e.key === 'F8') {
        e.preventDefault();
        setShowHeldModal(true);
      } else if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        handleSaveSale({ printSlip: false });
      } else if (e.key === 'Escape') {
        if (showSlipModal) {
          setShowSlipModal(false);
        } else if (showHeldModal) {
          setShowHeldModal(false);
        } else if (cart.length > 0) {
          if (window.confirm('Clear current bill?')) {
            clearCurrentBill();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cart, showClientModal, showSlipModal, showHeldModal, totals, selectedClient, paymentMode, tenderedAmount]);

  // Add product to cart (or increment if exists)
  const addToCart = (product, qtyToAdd = 1) => {
    setCart(prev => {
      const existingIndex = prev.findIndex(item => item.productId === product.id);
      if (existingIndex >= 0) {
        const next = [...prev];
        const item = next[existingIndex];
        const newQty = Math.round((Number(item.quantity) + qtyToAdd) * 1000) / 1000;
        next[existingIndex] = { ...item, quantity: newQty };
        return next;
      } else {
        const rate = Number(product.sellingPrice || product.rate) || 0;
        return [
          ...prev,
          {
            id: 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            productId: product.id,
            name: product.name,
            hsn: product.hsn || '',
            unit: product.unit || 'Pcs',
            rate: rate,
            quantity: qtyToAdd,
            taxPercent: Number(product.taxPercent) || 0,
            cessPercent: Number(product.cessPercent) || 0,
            discount: 0,
            discountType: 'percent',
            stock: product.stock ?? null
          }
        ];
      }
    });
    playBeep('add');
    barcodeInputRef.current?.focus();
  };

  // Barcode scanner input listener (Enter key)
  const handleBarcodeSubmit = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = searchQuery.trim();
      if (!code) return;

      // 1. Try exact barcode / SKU / itemCode match
      const exactCodeMatch = products.find(p =>
        (p.barcode && String(p.barcode).trim().toLowerCase() === code.toLowerCase()) ||
        (p.itemCode && String(p.itemCode).trim().toLowerCase() === code.toLowerCase()) ||
        (p.id && String(p.id).trim().toLowerCase() === code.toLowerCase())
      );

      if (exactCodeMatch) {
        addToCart(exactCodeMatch);
        setSearchQuery('');
        return;
      }

      // 2. Try exact name match
      const exactNameMatch = products.find(p =>
        p.name && p.name.trim().toLowerCase() === code.toLowerCase()
      );
      if (exactNameMatch) {
        addToCart(exactNameMatch);
        setSearchQuery('');
        return;
      }

      // 3. If single filtered match exists, pick it
      if (filteredProducts.length === 1) {
        addToCart(filteredProducts[0]);
        setSearchQuery('');
        return;
      }

      if (filteredProducts.length === 0) {
        playBeep('error');
        toast(`Item '${code}' not found in inventory`, 'warning');
      }
    }
  };

  // Change Item Qty
  const updateQuantity = (itemId, delta) => {
    setCart(prev => {
      return prev
        .map(item => {
          if (item.id === itemId) {
            const newQty = Math.round((Number(item.quantity) + delta) * 1000) / 1000;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean);
    });
    barcodeInputRef.current?.focus();
  };

  // Change Item Price
  const updateRate = (itemId, newRate) => {
    const r = Math.max(0, parseFloat(newRate) || 0);
    setCart(prev => prev.map(item => item.id === itemId ? { ...item, rate: r } : item));
  };

  // Remove single item
  const removeFromCart = (itemId) => {
    setCart(prev => prev.filter(item => item.id !== itemId));
    playBeep('hold');
    barcodeInputRef.current?.focus();
  };

  // Clear current cart
  const clearCurrentBill = () => {
    setCart([]);
    setTenderedAmount('');
    setBillDiscount({ value: 0, type: 'fixed' });
    setSelectedClient({
      name: 'Cash / Walk-in Customer',
      phone: '',
      gstin: '',
      state: profile?.state || ''
    });
    setPaymentMode('cash');
    refreshNextInvoiceNumber();
    barcodeInputRef.current?.focus();
  };

  // Hold current bill
  const handleHoldBill = () => {
    if (cart.length === 0) {
      toast('Cart is empty, nothing to hold', 'warning');
      return;
    }
    const held = {
      id: 'held_' + Date.now(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: localToday(),
      client: { ...selectedClient },
      cart: [...cart],
      invoiceType,
      taxInclusive,
      total: totals.total,
      itemsCount: cart.length
    };
    setHeldBills(prev => [held, ...prev]);
    playBeep('hold');
    toast(`Bill #${heldBills.length + 1} held for ${selectedClient.name}`, 'info');
    clearCurrentBill();
  };

  // Recall held bill
  const handleRecallBill = (held) => {
    if (cart.length > 0) {
      if (!window.confirm('Current cart has items. Replace with held bill?')) return;
    }
    setCart(held.cart);
    setSelectedClient(held.client);
    setInvoiceType(held.invoiceType || 'tax-invoice');
    setTaxInclusive(!!held.taxInclusive);
    setHeldBills(prev => prev.filter(h => h.id !== held.id));
    setShowHeldModal(false);
    playBeep('add');
    toast('Held bill restored', 'success');
  };

  // Calculate Change Due
  const changeDue = useMemo(() => {
    if (paymentMode !== 'cash') return 0;
    const tendered = Number(tenderedAmount) || 0;
    return Math.max(0, tendered - totals.total);
  }, [paymentMode, tenderedAmount, totals.total]);

  // Complete Sale (Save Bill + Deduct Stock + Print Slip)
  const handleSaveSale = async ({ printSlip = false } = {}) => {
    if (cart.length === 0) {
      playBeep('error');
      toast('Cannot checkout with an empty cart. Add items first.', 'warning');
      return;
    }
    if (isProcessing) return;

    setIsProcessing(true);
    try {
      // 1. Get official next invoice number
      const finalDocNumber = await getNextInvoiceNumber('INV', {
        invoiceType,
        businessKey: businessKeyOf(profile)
      });

      const todayDate = localToday();
      const isPaid = paymentMode !== 'credit';
      const paidAmount = isPaid ? totals.total : 0;

      // 2. Build full GST compliant bill object
      const bill = {
        id: finalDocNumber,
        invoiceNumber: finalDocNumber,
        clientName: selectedClient.name || 'Walk-in Customer',
        invoiceDate: todayDate,
        invoiceType: invoiceType || 'tax-invoice',
        currency: 'INR',
        totalAmount: totals.total,
        totalTaxAmount: Math.round(((totals.cgst || 0) + (totals.sgst || 0) + (totals.igst || 0) + (totals.utgst || 0)) * 100) / 100,
        status: isPaid ? 'paid' : 'unpaid',
        paidAmount: paidAmount,
        payments: isPaid ? [{
          id: `pay_${Date.now()}`,
          amount: totals.total,
          date: todayDate,
          mode: paymentMode,
          note: paymentMode === 'cash'
            ? `POS Cash (Tendered: ₹${tenderedAmount || totals.total}, Change: ₹${changeDue.toFixed(2)})`
            : `POS ${paymentMode.toUpperCase()}`,
          recordedAt: new Date().toISOString(),
          auto: true
        }] : [],
        printedCount: printSlip ? 1 : 0,
        lastPrintedAt: printSlip ? new Date().toISOString() : null,
        data: {
          profile: { ...(profile || {}) },
          client: { ...selectedClient },
          details: {
            invoiceNumber: finalDocNumber,
            invoiceDate: todayDate,
            dueDate: '',
            placeOfSupply: selectedClient.state || profile?.state || '',
            shipToSameAsBilling: true
          },
          items: cart.map(item => ({
            id: item.id || String(Date.now()),
            productId: item.productId || item.id,
            name: item.name,
            hsn: item.hsn || '',
            quantity: Number(item.quantity) || 1,
            unit: item.unit || 'Pcs',
            rate: Number(item.rate) || 0,
            discount: Number(item.discount) || 0,
            discountType: item.discountType || 'percent',
            taxPercent: Number(item.taxPercent) || 0,
            cessPercent: Number(item.cessPercent) || 0,
          })),
          totals: { ...totals },
          invoiceOptions: {
            currency: 'INR',
            paperSize: 'thermal80',
            taxInclusive: !!taxInclusive,
            showGST: invoiceType === 'tax-invoice',
            paymentMode
          },
          stockApplied: stockEffect(cart.map(i => ({ ...i, productId: i.productId || i.id })), invoiceType || 'tax-invoice', isPaid ? 'paid' : 'unpaid')
        }
      };

      // 3. Save Bill to database
      await saveBill(bill, { overwrite: false });

      // 4. Move inventory stock in real-time
      const changes = stockDelta({}, bill.data.stockApplied);
      if (Object.keys(changes).length) {
        await applyStockChanges(changes);
      }

      // 5. Refresh product catalog in background to update on-screen stock badges
      getAllProducts().then(setProducts).catch(() => {});

      // 6. Play success beep
      playBeep('success');
      toast(`Bill ${finalDocNumber} saved successfully!`, 'success');

      // 7. Store sale for receipt modal
      const saleDetails = {
        ...bill,
        cart: [...cart],
        totals: { ...totals },
        tenderedAmount: tenderedAmount || totals.total,
        changeDue: changeDue,
        paymentMode
      };
      setCompletedSale(saleDetails);

      if (printSlip) {
        setShowSlipModal(true);
      }

      // Reset cart for next customer
      clearCurrentBill();

    } catch (err) {
      console.error('POS Checkout Failed', err);
      playBeep('error');
      toast(`Checkout failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  // WhatsApp share of the completed POS invoice
  const handleShareWhatsApp = (sale) => {
    if (!sale) return;
    const phone = sale.client?.phone || sale.clientName;
    const msg = `*${profile?.businessName || 'Tax Invoice'}*\n` +
      `Bill No: *${sale.invoiceNumber}*\n` +
      `Date: ${sale.invoiceDate}\n` +
      `Total: *${formatCurrency(sale.totalAmount, 'INR')}*\n` +
      `Status: ${sale.status === 'paid' ? 'Paid (' + sale.paymentMode?.toUpperCase() + ')' : 'Payment Due'}\n\n` +
      `Thank you for shopping with us!`;
    openWhatsAppShare(phone, msg);
  };

  // Direct Browser Print for Thermal Slip
  const triggerThermalPrint = () => {
    window.print();
  };

  return (
    <div className="pos-app-wrapper" style={{ minHeight: '100vh', background: 'var(--bg-primary, #f0f2f5)', display: 'flex', flexDirection: 'column' }}>

      {/* TOP HEADER / ACTION BAR */}
      <header style={{
        background: 'var(--card-bg, #ffffff)',
        borderBottom: '1px solid var(--border, #e2e8f0)',
        padding: '0.6rem 1.25rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <button
            className="btn btn-secondary"
            onClick={onBack}
            style={{ padding: '0.45rem 0.75rem', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
            title="Back to Dashboard"
          >
            <ArrowLeft size={16} /> Exit POS
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              color: '#fff',
              padding: '0.35rem 0.65rem',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              fontWeight: 700,
              fontSize: '0.9rem'
            }}>
              <Zap size={16} /> POS Counter
            </div>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>|</span>
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{profile?.businessName || 'Retail Store'}</span>
            {profile?.gstin && (
              <span style={{ fontSize: '0.75rem', background: 'var(--bg-secondary)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: 'var(--text-secondary)' }}>
                GSTIN: {profile.gstin}
              </span>
            )}
          </div>
        </div>

        {/* CUSTOMER & BILL CONFIG ROW */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {/* Customer button */}
          <button
            type="button"
            onClick={() => setShowClientModal(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: selectedClient.name.includes('Walk-in') ? 'var(--bg-secondary)' : '#eff6ff',
              border: `1px solid ${selectedClient.name.includes('Walk-in') ? 'var(--border)' : '#93c5fd'}`,
              color: selectedClient.name.includes('Walk-in') ? 'var(--text)' : '#1d4ed8',
              padding: '0.35rem 0.75rem',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: 600
            }}
          >
            <User size={15} />
            <span>{selectedClient.name}</span>
            {selectedClient.phone && <span style={{ opacity: 0.8, fontSize: '0.75rem' }}>({selectedClient.phone})</span>}
          </button>

          {/* Tax Inclusive / Exclusive toggle */}
          <div style={{
            display: 'inline-flex',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            overflow: 'hidden',
            fontSize: '0.78rem'
          }}>
            <button
              type="button"
              onClick={() => setTaxInclusive(false)}
              style={{
                padding: '0.35rem 0.6rem',
                border: 'none',
                background: !taxInclusive ? 'var(--primary)' : 'var(--bg-secondary)',
                color: !taxInclusive ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              Tax Excl.
            </button>
            <button
              type="button"
              onClick={() => setTaxInclusive(true)}
              style={{
                padding: '0.35rem 0.6rem',
                border: 'none',
                background: taxInclusive ? 'var(--primary)' : 'var(--bg-secondary)',
                color: taxInclusive ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              MRP / Incl.
            </button>
          </div>

          {/* Held Bills Counter Button */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowHeldModal(true)}
            style={{ padding: '0.35rem 0.65rem', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
          >
            <Clock size={15} />
            <span>Held ({heldBills.length})</span>
          </button>

          {/* Clear Cart Button */}
          <button
            type="button"
            onClick={clearCurrentBill}
            disabled={cart.length === 0}
            style={{
              padding: '0.35rem 0.65rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: cart.length > 0 ? '#ef4444' : 'var(--text-muted)',
              cursor: cart.length > 0 ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              fontSize: '0.82rem'
            }}
            title="Clear Cart (Esc)"
          >
            <RotateCcw size={14} /> Clear
          </button>
        </div>
      </header>

      {/* MAIN TWO-COLUMN POS WORKSPACE */}
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.35fr) minmax(380px, 1fr)',
        gap: '1rem',
        padding: '1rem',
        maxWidth: '1700px',
        width: '100%',
        margin: '0 auto',
        boxSizing: 'border-box'
      }}>

        {/* LEFT COLUMN: SCANNER & PRODUCT CATALOG */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minHeight: 0 }}>

          {/* BARCODE SCANNER & ITEM SEARCH BOX */}
          <div style={{
            background: 'var(--card-bg, #ffffff)',
            borderRadius: '10px',
            padding: '0.75rem 1rem',
            border: '1px solid var(--border, #e2e8f0)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.03)'
          }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <div style={{ position: 'absolute', left: '12px', color: 'var(--primary)', display: 'flex', alignItems: 'center' }}>
                <Search size={18} />
              </div>
              <input
                ref={barcodeInputRef}
                type="text"
                className="form-input"
                placeholder="Scan barcode gun or type item name / HSN (Press Enter to add)... [F1]"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={handleBarcodeSubmit}
                style={{
                  width: '100%',
                  paddingLeft: '2.5rem',
                  paddingRight: '4.5rem',
                  fontSize: '0.98rem',
                  height: '46px',
                  borderRadius: '8px',
                  border: '2px solid var(--border)',
                  outline: 'none',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)'
                }}
              />
              <div style={{ position: 'absolute', right: '10px', display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.72rem', background: 'var(--bg-secondary)', padding: '0.2rem 0.45rem', borderRadius: '4px', color: 'var(--text-muted)' }}>
                  Enter ↵
                </span>
              </div>
            </div>

            {/* Category Filter Chips */}
            {categories.length > 0 && (
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.65rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
                <button
                  type="button"
                  onClick={() => setSelectedCategory('all')}
                  style={{
                    padding: '0.25rem 0.65rem',
                    borderRadius: '999px',
                    border: 'none',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: selectedCategory === 'all' ? 'var(--primary)' : 'var(--bg-secondary)',
                    color: selectedCategory === 'all' ? '#fff' : 'var(--text-secondary)'
                  }}
                >
                  All Items ({products.length})
                </button>
                {categories.map(cat => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    style={{
                      padding: '0.25rem 0.65rem',
                      borderRadius: '999px',
                      border: 'none',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      background: selectedCategory === cat ? 'var(--primary)' : 'var(--bg-secondary)',
                      color: selectedCategory === cat ? '#fff' : 'var(--text-secondary)'
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* PRODUCT TILES GRID */}
          <div style={{
            flex: 1,
            background: 'var(--card-bg, #ffffff)',
            borderRadius: '10px',
            padding: '0.85rem',
            border: '1px solid var(--border, #e2e8f0)',
            overflowY: 'auto',
            maxHeight: 'calc(100vh - 195px)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '0.75rem',
            alignContent: 'start'
          }}>
            {filteredProducts.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '3.5rem 1rem', color: 'var(--text-muted)' }}>
                <Tag size={40} style={{ margin: '0 auto 0.75rem', opacity: 0.4 }} />
                <p style={{ fontWeight: 600, fontSize: '0.95rem', margin: 0 }}>No items match your search</p>
                <p style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>Scan barcode or type item name to search</p>
              </div>
            ) : (
              filteredProducts.map(p => {
                const inCart = cart.find(c => c.productId === p.id);
                const price = Number(p.sellingPrice || p.rate) || 0;
                const hasStock = p.stock !== null && p.stock !== undefined;
                const isOutOfStock = hasStock && p.stock <= 0;
                const isLowStock = hasStock && p.stock > 0 && p.stock <= 5;

                return (
                  <div
                    key={p.id}
                    onClick={() => addToCart(p)}
                    style={{
                      background: inCart ? 'rgba(37, 99, 235, 0.05)' : 'var(--bg-secondary, #f8fafc)',
                      border: `1.5px solid ${inCart ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius: '8px',
                      padding: '0.75rem',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      position: 'relative',
                      transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'none'}
                  >
                    {/* In-Cart Quantity Badge */}
                    {inCart && (
                      <span style={{
                        position: 'absolute',
                        top: '-8px',
                        right: '-8px',
                        background: 'var(--primary)',
                        color: '#fff',
                        fontWeight: 700,
                        fontSize: '0.72rem',
                        padding: '0.15rem 0.45rem',
                        borderRadius: '999px',
                        boxShadow: '0 2px 4px rgba(37,99,235,0.35)'
                      }}>
                        x{inCart.quantity}
                      </span>
                    )}

                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)', lineHeight: 1.25, marginBottom: '0.3rem' }}>
                        {p.name}
                      </div>
                      {p.hsn && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          HSN: {p.hsn}
                        </div>
                      )}
                    </div>

                    <div style={{ marginTop: '0.65rem', paddingTop: '0.45rem', borderTop: '1px dashed var(--border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--primary)' }}>
                          {formatCurrency(price, 'INR')}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          /{p.unit || 'Pcs'}
                        </span>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem', fontSize: '0.72rem' }}>
                        <span style={{ background: 'rgba(0,0,0,0.05)', padding: '0.1rem 0.3rem', borderRadius: '3px' }}>
                          {p.taxPercent || 0}% GST
                        </span>

                        {hasStock && (
                          <span style={{
                            fontWeight: 600,
                            color: isOutOfStock ? '#dc2626' : isLowStock ? '#d97706' : '#16a34a'
                          }}>
                            {isOutOfStock ? '0 Stock' : `${p.stock} left`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: POS CART & BILLING CHECKOUT */}
        <div style={{
          background: 'var(--card-bg, #ffffff)',
          borderRadius: '10px',
          border: '1px solid var(--border, #e2e8f0)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          overflow: 'hidden',
          maxHeight: 'calc(100vh - 95px)'
        }}>

          {/* CART HEADER */}
          <div style={{
            padding: '0.75rem 1rem',
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Invoice No.</div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text)' }}>{invoiceNumber || 'INV-...'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Total Items</div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--primary)' }}>
                {cart.length} ({cart.reduce((s, i) => s + (Number(i.quantity) || 0), 0)} pcs)
              </div>
            </div>
          </div>

          {/* CART ITEMS LIST / TABLE */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.5rem',
            minHeight: '220px'
          }}>
            {cart.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
                <ShoppingCart size={44} style={{ margin: '0 auto 0.5rem', opacity: 0.3 }} />
                <p style={{ fontWeight: 600, fontSize: '0.95rem', margin: 0 }}>Bill cart is empty</p>
                <p style={{ fontSize: '0.8rem', margin: '0.35rem 0 0' }}>Scan barcode or click items on the left to add</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '0.4rem 0.3rem', width: '38%' }}>Item</th>
                    <th style={{ padding: '0.4rem 0.3rem', textAlign: 'right', width: '20%' }}>Rate</th>
                    <th style={{ padding: '0.4rem 0.3rem', textAlign: 'center', width: '22%' }}>Qty</th>
                    <th style={{ padding: '0.4rem 0.3rem', textAlign: 'right', width: '20%' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((item, idx) => {
                    const lineGross = Math.round((Number(item.rate) || 0) * (Number(item.quantity) || 0) * 100) / 100;
                    return (
                      <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.5rem 0.3rem' }}>
                          <div style={{ fontWeight: 600, color: 'var(--text)', lineHeight: 1.2 }}>{item.name}</div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {item.taxPercent}% GST {item.hsn ? `· HSN ${item.hsn}` : ''}
                          </div>
                        </td>

                        <td style={{ padding: '0.5rem 0.3rem', textAlign: 'right' }}>
                          <input
                            type="number"
                            value={item.rate}
                            onChange={e => updateRate(item.id, e.target.value)}
                            style={{
                              width: '65px',
                              textAlign: 'right',
                              padding: '0.2rem 0.3rem',
                              borderRadius: '4px',
                              border: '1px solid var(--border)',
                              fontSize: '0.82rem'
                            }}
                          />
                        </td>

                        <td style={{ padding: '0.5rem 0.3rem', textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <button
                              type="button"
                              onClick={() => updateQuantity(item.id, -1)}
                              style={{
                                width: '22px', height: '22px', borderRadius: '4px', border: '1px solid var(--border)',
                                background: 'var(--bg-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                              }}
                            >
                              <Minus size={12} />
                            </button>
                            <span style={{ fontWeight: 600, minWidth: '24px', textAlign: 'center' }}>
                              {item.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateQuantity(item.id, 1)}
                              style={{
                                width: '22px', height: '22px', borderRadius: '4px', border: '1px solid var(--border)',
                                background: 'var(--bg-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                              }}
                            >
                              <Plus size={12} />
                            </button>
                          </div>
                        </td>

                        <td style={{ padding: '0.5rem 0.3rem', textAlign: 'right', fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.35rem' }}>
                            <span>{formatCurrency(lineGross, 'INR')}</span>
                            <button
                              type="button"
                              onClick={() => removeFromCart(item.id)}
                              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
                              title="Delete item"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* TOTALS & BREAKDOWN SECTION */}
          <div style={{
            background: 'var(--bg-secondary)',
            borderTop: '1px solid var(--border)',
            padding: '0.75rem 1rem',
            fontSize: '0.84rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
              <span>Taxable Subtotal:</span>
              <span>{formatCurrency(totals.taxableAmount || totals.subtotal || 0, 'INR')}</span>
            </div>

            {invoiceType === 'tax-invoice' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>
                <span>GST ({totals.isInterstate ? 'IGST' : 'CGST + SGST'}):</span>
                <span>{formatCurrency((totals.cgst || 0) + (totals.sgst || 0) + (totals.igst || 0) + (totals.utgst || 0), 'INR')}</span>
              </div>
            )}

            {/* Bill Discount Row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Discount (₹):</span>
              <input
                type="number"
                min="0"
                value={billDiscount.value || ''}
                placeholder="0"
                onChange={e => setBillDiscount({ type: 'fixed', value: Math.max(0, parseFloat(e.target.value) || 0) })}
                style={{
                  width: '75px',
                  textAlign: 'right',
                  padding: '0.15rem 0.35rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border)',
                  fontSize: '0.8rem'
                }}
              />
            </div>

            {totals.roundOff !== 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                <span>Round off:</span>
                <span>{totals.roundOff > 0 ? `+₹${totals.roundOff}` : `-₹${Math.abs(totals.roundOff)}`}</span>
              </div>
            )}

            {/* GRAND TOTAL */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              paddingTop: '0.5rem',
              marginTop: '0.35rem',
              borderTop: '1.5px dashed var(--border)',
              fontWeight: 800,
              fontSize: '1.25rem',
              color: 'var(--primary)'
            }}>
              <span>Grand Total:</span>
              <span>{formatCurrency(totals.total, 'INR')}</span>
            </div>
          </div>

          {/* PAYMENT MODE & TENDER SELECTOR (Vyapar Signature) */}
          <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.35rem', marginBottom: '0.65rem' }}>
              {[
                { id: 'cash', label: 'Cash', icon: Banknote },
                { id: 'upi', label: 'UPI / QR', icon: QrCode },
                { id: 'card', label: 'Card', icon: CreditCard },
                { id: 'credit', label: 'Udhar', icon: Clock }
              ].map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setPaymentMode(mode.id)}
                  style={{
                    padding: '0.45rem 0.2rem',
                    borderRadius: '6px',
                    border: `1.5px solid ${paymentMode === mode.id ? 'var(--primary)' : 'var(--border)'}`,
                    background: paymentMode === mode.id ? 'var(--primary)' : 'var(--bg-secondary)',
                    color: paymentMode === mode.id ? '#fff' : 'var(--text)',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.2rem'
                  }}
                >
                  <mode.icon size={15} />
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>

            {/* CASH TENDER & CHANGE DUE CALCULATOR */}
            {paymentMode === 'cash' && (
              <div style={{
                background: 'var(--bg-secondary)',
                borderRadius: '8px',
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border)',
                marginBottom: '0.5rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Cash Received:</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ fontWeight: 600 }}>₹</span>
                    <input
                      type="number"
                      placeholder={totals.total.toString()}
                      value={tenderedAmount}
                      onChange={e => setTenderedAmount(e.target.value)}
                      style={{
                        width: '90px',
                        padding: '0.25rem 0.4rem',
                        borderRadius: '4px',
                        border: '1px solid var(--border)',
                        fontWeight: 700,
                        textAlign: 'right',
                        fontSize: '0.9rem'
                      }}
                    />
                  </div>
                </div>

                {/* Quick denomination chips */}
                <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.4rem', overflowX: 'auto' }}>
                  <button
                    type="button"
                    onClick={() => setTenderedAmount(totals.total.toString())}
                    style={{ fontSize: '0.72rem', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid var(--border)', background: '#fff', cursor: 'pointer' }}
                  >
                    Exact
                  </button>
                  {[50, 100, 200, 500, 2000].map(amt => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setTenderedAmount(amt.toString())}
                      style={{ fontSize: '0.72rem', padding: '0.15rem 0.45rem', borderRadius: '4px', border: '1px solid var(--border)', background: '#fff', cursor: 'pointer' }}
                    >
                      ₹{amt}
                    </button>
                  ))}
                </div>

                {/* Balance Return Alert */}
                {Number(tenderedAmount) > totals.total && (
                  <div style={{
                    marginTop: '0.45rem',
                    padding: '0.35rem 0.5rem',
                    background: '#ecfdf5',
                    borderRadius: '4px',
                    border: '1px solid #a7f3d0',
                    color: '#065f46',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontWeight: 700,
                    fontSize: '0.85rem'
                  }}>
                    <span>Change to Return:</span>
                    <span style={{ fontSize: '0.95rem' }}>₹{changeDue.toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            {/* DYNAMIC UPI QR POPUP */}
            {paymentMode === 'upi' && (
              <div style={{
                background: '#f8fafc',
                borderRadius: '8px',
                padding: '0.65rem',
                border: '1px solid #e2e8f0',
                textAlign: 'center',
                marginBottom: '0.5rem'
              }}>
                {upiQrUrl ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <img src={upiQrUrl} alt="UPI QR Code" style={{ width: '130px', height: '130px', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#1e40af', marginTop: '0.3rem' }}>
                      Scan & Pay ₹{totals.total.toFixed(2)} via GPay / PhonePe / Paytm
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: '#64748b', padding: '0.5rem' }}>
                    {profile?.upiId ? 'Generating QR...' : 'Set UPI ID in Settings to show QR here'}
                  </div>
                )}
              </div>
            )}

            {/* BOTTOM ACTION BUTTONS */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: '0.5rem', marginTop: '0.35rem' }}>
              {/* SAVE & PRINT SLIP (F2) */}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleSaveSale({ printSlip: true })}
                disabled={cart.length === 0 || isProcessing}
                style={{
                  background: 'linear-gradient(135deg, #16a34a, #15803d)',
                  borderColor: '#15803d',
                  padding: '0.7rem 0.5rem',
                  fontSize: '0.95rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  boxShadow: '0 4px 12px rgba(22, 163, 74, 0.25)'
                }}
                title="Save Bill & Print Thermal Receipt [F2]"
              >
                <Printer size={18} />
                <span>{isProcessing ? 'Saving...' : 'Print Slip [F2]'}</span>
              </button>

              {/* QUICK SAVE & NEXT (Ctrl+Enter) */}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => handleSaveSale({ printSlip: false })}
                disabled={cart.length === 0 || isProcessing}
                style={{
                  padding: '0.7rem 0.5rem',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.35rem'
                }}
                title="Quick Save & Next [Ctrl+Enter]"
              >
                <Check size={16} />
                <span>Quick Save</span>
              </button>
            </div>

            {/* HOLD BILL BUTTON ROW */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span onClick={handleHoldBill} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                <PauseCircle size={13} /> Hold Bill [F4]
              </span>
              <span>·</span>
              <span onClick={() => setShowHeldModal(true)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                <PlayCircle size={13} /> Recall [F8]
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================== */}
      {/* THERMAL PRINT SLIP MODAL (58mm / 80mm POS Slip Preview)       */}
      {/* ============================================================== */}
      {showSlipModal && completedSale && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.65)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: '1rem'
        }}>
          <div style={{
            background: '#ffffff',
            color: '#111827',
            width: '380px',
            maxWidth: '100%',
            borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '90vh'
          }}>
            {/* Modal Header */}
            <div style={{
              padding: '0.75rem 1rem',
              background: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Thermal Receipt Preview</span>
              <button
                type="button"
                onClick={() => setShowSlipModal(false)}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748b' }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Receipt Printable Paper Body */}
            <div id="pos-thermal-receipt" style={{
              flex: 1,
              overflowY: 'auto',
              padding: '1.25rem 1rem',
              fontFamily: 'Courier, monospace, monospace',
              fontSize: '12px',
              lineHeight: 1.35
            }}>
              {/* Header */}
              <div style={{ textAlign: 'center', marginBottom: '0.65rem' }}>
                <div style={{ fontWeight: 800, fontSize: '15px', textTransform: 'uppercase' }}>
                  {profile?.businessName || 'RETAIL STORE'}
                </div>
                {profile?.address && <div style={{ fontSize: '11px' }}>{profile.address}</div>}
                {profile?.phone && <div style={{ fontSize: '11px' }}>Tel: {profile.phone}</div>}
                {profile?.gstin && <div style={{ fontSize: '11px', fontWeight: 600 }}>GSTIN: {profile.gstin}</div>}
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '0.4rem 0' }} />

              {/* Meta */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                <span>Bill: {completedSale.invoiceNumber}</span>
                <span>Date: {completedSale.invoiceDate}</span>
              </div>
              <div style={{ fontSize: '11px' }}>
                Customer: {completedSale.clientName || 'Walk-in'}
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '0.4rem 0' }} />

              {/* Item Table */}
              <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #000' }}>
                    <th style={{ textAlign: 'left', padding: '2px 0' }}>Item</th>
                    <th style={{ textAlign: 'right', padding: '2px 0' }}>Qty</th>
                    <th style={{ textAlign: 'right', padding: '2px 0' }}>Rate</th>
                    <th style={{ textAlign: 'right', padding: '2px 0' }}>Amt</th>
                  </tr>
                </thead>
                <tbody>
                  {completedSale.cart?.map((it, i) => (
                    <tr key={i}>
                      <td style={{ padding: '2px 0', verticalAlign: 'top' }}>{it.name}</td>
                      <td style={{ textAlign: 'right', padding: '2px 0', verticalAlign: 'top' }}>{it.quantity}</td>
                      <td style={{ textAlign: 'right', padding: '2px 0', verticalAlign: 'top' }}>{it.rate}</td>
                      <td style={{ textAlign: 'right', padding: '2px 0', verticalAlign: 'top', fontWeight: 600 }}>
                        {(it.quantity * it.rate).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ borderTop: '1px dashed #000', margin: '0.4rem 0' }} />

              {/* Totals */}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Subtotal:</span>
                <span>₹{(completedSale.totals?.taxableAmount || completedSale.totals?.subtotal || 0).toFixed(2)}</span>
              </div>
              {completedSale.totals?.cgst > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span>CGST:</span>
                  <span>₹{completedSale.totals.cgst.toFixed(2)}</span>
                </div>
              )}
              {completedSale.totals?.sgst > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span>SGST:</span>
                  <span>₹{completedSale.totals.sgst.toFixed(2)}</span>
                </div>
              )}
              {completedSale.totals?.igst > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span>IGST:</span>
                  <span>₹{completedSale.totals.igst.toFixed(2)}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '14px', marginTop: '0.25rem', borderTop: '1px solid #000', paddingTop: '0.2rem' }}>
                <span>NET TOTAL:</span>
                <span>₹{completedSale.totalAmount.toFixed(2)}</span>
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '0.4rem 0' }} />

              {/* Payment Details */}
              <div style={{ fontSize: '11px' }}>
                <div>Paid via: {completedSale.paymentMode?.toUpperCase()}</div>
                {completedSale.paymentMode === 'cash' && (
                  <>
                    <div>Tendered: ₹{completedSale.tenderedAmount}</div>
                    {completedSale.changeDue > 0 && <div>Change Returned: ₹{completedSale.changeDue.toFixed(2)}</div>}
                  </>
                )}
              </div>

              {/* Footer */}
              <div style={{ textAlign: 'center', marginTop: '0.85rem', fontSize: '11px' }}>
                <div>*** THANK YOU! VISIT AGAIN ***</div>
                <div style={{ fontSize: '9px', opacity: 0.7, marginTop: '2px' }}>Free GST Billing Software</div>
              </div>
            </div>

            {/* Modal Actions */}
            <div style={{
              padding: '0.75rem 1rem',
              background: '#f8fafc',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              gap: '0.5rem'
            }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={triggerThermalPrint}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
              >
                <Printer size={16} /> Print Slip
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => handleShareWhatsApp(completedSale)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title="Share on WhatsApp"
              >
                <Share2 size={16} /> WhatsApp
              </button>

              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setShowSlipModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* RECALL HELD BILLS MODAL                                       */}
      {/* ============================================================== */}
      {showHeldModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: '1rem'
        }}>
          <div style={{
            background: 'var(--card-bg, #ffffff)',
            width: '500px',
            maxWidth: '100%',
            borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
            overflow: 'hidden'
          }}>
            <div style={{
              padding: '0.75rem 1rem',
              background: 'var(--bg-secondary)',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Held Bills ({heldBills.length})</span>
              <button type="button" onClick={() => setShowHeldModal(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ maxHeight: '380px', overflowY: 'auto', padding: '0.75rem' }}>
              {heldBills.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)' }}>
                  <Clock size={36} style={{ margin: '0 auto 0.5rem', opacity: 0.4 }} />
                  <p style={{ margin: 0 }}>No bills are on hold</p>
                </div>
              ) : (
                heldBills.map(h => (
                  <div
                    key={h.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.65rem 0.85rem',
                      borderRadius: '8px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      marginBottom: '0.5rem'
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{h.client?.name || 'Walk-in Customer'}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {h.timestamp} · {h.itemsCount} items · <strong style={{ color: 'var(--primary)' }}>₹{h.total?.toFixed(2)}</strong>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleRecallBill(h)}
                        style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => setHeldBills(prev => prev.filter(x => x.id !== h.id))}
                        style={{ border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer', padding: '0.35rem' }}
                        title="Delete held bill"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* CUSTOMER SELECT / QUICK ADD MODAL                             */}
      {/* ============================================================== */}
      {showClientModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: '1rem'
        }}>
          <div style={{
            background: 'var(--card-bg, #ffffff)',
            width: '460px',
            maxWidth: '100%',
            borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2)',
            overflow: 'hidden'
          }}>
            <div style={{
              padding: '0.75rem 1rem',
              background: 'var(--bg-secondary)',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Select or Add Customer</span>
              <button type="button" onClick={() => setShowClientModal(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: '1rem' }}>
              {/* Quick Walk-in Option */}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSelectedClient({
                    name: 'Cash / Walk-in Customer',
                    phone: '',
                    gstin: '',
                    state: profile?.state || ''
                  });
                  setShowClientModal(false);
                }}
                style={{ width: '100%', marginBottom: '0.75rem', justifyContent: 'flex-start' }}
              >
                <User size={16} /> Use Default Walk-in Customer
              </button>

              <div style={{ margin: '0.75rem 0', borderTop: '1px solid var(--border)', position: 'relative', textAlign: 'center' }}>
                <span style={{ position: 'absolute', top: '-10px', background: 'var(--card-bg)', padding: '0 0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  OR ENTER DETAILS
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '1rem' }}>
                <div>
                  <label className="form-label">Customer Name</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. Ramesh Kumar"
                    value={selectedClient.name.includes('Walk-in') ? '' : selectedClient.name}
                    onChange={e => setSelectedClient(c => ({ ...c, name: e.target.value }))}
                  />
                </div>

                <div>
                  <label className="form-label">Mobile Number (for WhatsApp Receipt)</label>
                  <input
                    type="tel"
                    className="form-input"
                    placeholder="e.g. 9876543210"
                    value={selectedClient.phone || ''}
                    onChange={e => setSelectedClient(c => ({ ...c, phone: e.target.value }))}
                  />
                </div>

                <div>
                  <label className="form-label">Customer GSTIN (Optional)</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="22AAAAA0000A1Z5"
                    value={selectedClient.gstin || ''}
                    onChange={e => setSelectedClient(c => ({ ...c, gstin: e.target.value.toUpperCase() }))}
                  />
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    if (!selectedClient.name.trim()) {
                      setSelectedClient(c => ({ ...c, name: 'Cash / Walk-in Customer' }));
                    }
                    setShowClientModal(false);
                  }}
                  style={{ marginTop: '0.5rem' }}
                >
                  Save & Apply Customer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PRINT-ONLY CSS STYLES FOR THERMAL SLIP */}
      <style>{`
        @media print {
          body * {
            visibility: hidden !important;
          }
          #pos-thermal-receipt, #pos-thermal-receipt * {
            visibility: visible !important;
          }
          #pos-thermal-receipt {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 80mm !important;
            max-width: 80mm !important;
            padding: 2mm !important;
            margin: 0 !important;
          }
        }
      `}</style>

    </div>
  );
}

