/* Hengyi delivery domain logic. Keep this file free of DOM and network code. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HengCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PACKAGE_FIELDS = [
    ['cartons', '纸箱'],
    ['pallets', '托盘'],
    ['newFrames', '新框'],
    ['oldFrames', '老框'],
    ['newRacks', '新架'],
    ['oldRacks', '老架'],
  ];

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function splitNotes(items, capacity) {
    const list = Array.isArray(items) ? items : [];
    const size = Math.max(1, Math.floor(toNumber(capacity, 1)));
    const pages = [];
    for (let index = 0; index < list.length; index += size) {
      pages.push(list.slice(index, index + size));
    }
    return pages;
  }

  function allocateBogo(totals, orders) {
    const quantities = {
      '07': toNumber(totals && totals.quantity07, 0),
      '01': toNumber(totals && totals.quantity01, 0),
      '02': toNumber(totals && totals.quantity02, 0),
    };
    for (const productCode of ['07', '01', '02']) {
      if (!Number.isFinite(quantities[productCode]) || quantities[productCode] < 0) {
        return { rows: [], error: `${productCode} 锁数量不能小于 0` };
      }
    }

    const remaining = (Array.isArray(orders) ? orders : []).map((order, index) => ({
      orderNo: String(order && order.orderNo || '').trim(),
      sortOrder: toNumber(order && order.sortOrder, index),
      remaining07: Math.max(0, toNumber(order && order.remaining07, 0)),
      remaining01: Math.max(0, toNumber(order && order.remaining01, 0)),
      remaining02: Math.max(0, toNumber(order && order.remaining02, 0)),
    })).filter((order) => order.orderNo).sort((a, b) => a.sortOrder - b.sortOrder);

    if (!remaining.length && Object.values(quantities).some((quantity) => quantity > 0)) {
      return { rows: [], error: '没有可分配的博戈订单' };
    }

    const rows = [];
    for (const productCode of ['07', '01', '02']) {
      const total = quantities[productCode];
      const field = `remaining${productCode}`;
      let pending = total;
      for (const order of remaining) {
        if (pending <= 0) break;
        const take = Math.min(pending, order[field]);
        if (take <= 0) continue;
        rows.push({ orderNo: order.orderNo, productCode, quantity: take });
        order[field] -= take;
        pending -= take;
      }
      if (pending > 0) {
        return { rows: [], error: `${productCode} 锁超出可分配数量 ${pending}` };
      }
    }
    return { rows, error: '' };
  }

  function orderedFields(packaging) {
    const labels = new Map(PACKAGE_FIELDS);
    const requested = Array.isArray(packaging && packaging.order) ? packaging.order : [];
    const fields = [];
    for (const key of requested) {
      if (labels.has(key) && !fields.includes(key)) fields.push(key);
    }
    for (const [key] of PACKAGE_FIELDS) {
      if (!fields.includes(key)) fields.push(key);
    }
    return fields.map((key) => [key, labels.get(key)]);
  }

  function formatPackaging(packaging) {
    const value = packaging || {};
    if (value.noPackaging) return '无包装';
    const parts = [];
    for (const [key, label] of orderedFields(value)) {
      const count = toNumber(value[key], 0);
      if (count > 0) parts.push(`${count}${label}`);
    }
    const otherQuantity = toNumber(value.otherQuantity, 0);
    const otherName = String(value.otherName || '').trim();
    if (otherQuantity > 0 && otherName) parts.push(`${otherQuantity}${otherName}`);
    return parts.join('');
  }

  function validatePackaging(packaging) {
    const value = packaging || {};
    if (value.noPackaging) return { valid: true, text: '无包装', error: '' };
    for (const [key] of PACKAGE_FIELDS) {
      const count = toNumber(value[key], 0);
      if (!Number.isFinite(count) || count < 0) {
        return { valid: false, text: '', error: '包装数量不能小于 0' };
      }
    }
    const otherQuantity = toNumber(value.otherQuantity, 0);
    const otherName = String(value.otherName || '').trim();
    if (otherQuantity < 0) return { valid: false, text: '', error: '其他包装数量不能小于 0' };
    if (otherQuantity > 0 && !otherName) return { valid: false, text: '', error: '请填写其他包装名称' };
    const text = formatPackaging(value);
    return { valid: Boolean(text), text, error: text ? '' : '请选择至少一种包装，或选择本页无包装' };
  }

  function packagingSignature(notes) {
    return JSON.stringify((Array.isArray(notes) ? notes : []).map((note) => ({
      customerCode: String(note && note.customerCode || ''),
      orderNumbers: String(note && note.orderNumbers || ''),
      items: (Array.isArray(note && note.items) ? note.items : []).map((item) => ({
        materialCode: String(item && item.materialCode || ''),
        orderNo: String(item && item.orderNo || ''),
        quantity: toNumber(item && item.quantity, 0),
      })),
    })));
  }

  return {
    PACKAGE_FIELDS,
    splitNotes,
    allocateBogo,
    formatPackaging,
    validatePackaging,
    packagingSignature,
  };
});
