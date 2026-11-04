/**
 * Values used only by this module. Shared enums hold what several modules need;
 * these stay here, and the UI labels live in the sales i18n namespace.
 */
export const GRANT_KINDS = ['subsidy', 'compensation', 'grant', 'preferential_loan'] as const;
export const GRANT_STATUSES = ['draft', 'submitted', 'in_review', 'approved', 'rejected', 'received'] as const;

export const CONTRACT_STATUSES = ['draft', 'active', 'closed', 'terminated'] as const;

export const REPORT_AUTHORITIES = ['veterinary', 'statistics', 'tax', 'other'] as const;
export const REPORT_PERIODS = ['once', 'monthly', 'quarterly', 'yearly'] as const;
export const REPORT_STATUSES = ['planned', 'submitted'] as const;

export const PRICE_KINDS = ['sale', 'market'] as const;

/** A sale always moves value, so `non_cash` is not offered here. */
export const SALE_PAYMENT_METHODS = ['cash', 'bank', 'card', 'debt'] as const;

/** Days ahead that count as "expiring soon". */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * Upper limits for request numbers. They fit the money and quantity columns, so an absurd value
 * is a field error on the form rather than a database overflow with a vague message.
 */
export const MAX_MONEY = 1e14;
export const MAX_QTY = 1e12;
