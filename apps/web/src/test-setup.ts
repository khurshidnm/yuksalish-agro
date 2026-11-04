// lib/i18n touches <html lang>; these tests exercise logic, not the DOM.
Object.assign(globalThis, { document: { documentElement: {} } });
