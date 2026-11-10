import type { AnimalStatus, CATALOGUE_REQUEST_STATUSES, RESERVATION_STATUSES } from '@yap/shared';

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type CatalogueRequestStatus = (typeof CATALOGUE_REQUEST_STATUSES)[number];

export const RESERVATIONS = '/sales/reservations';
export const LISTINGS = '/sales/catalogue/listings';
export const REQUESTS = '/sales/catalogue/requests';
export const READINESS = '/livestock/sale-readiness';

/** Everything a reservation, a listing or a request can change on screen. */
export const SALE_HOLD_PATHS = [RESERVATIONS, LISTINGS, REQUESTS, READINESS];

/** An animal held for a buyer. Price, name and phone arrive as null for people who may not see them. */
export interface Reservation {
  id: string;
  animalId: string;
  animalTag: string;
  animalCategory: string;
  animalStatus: AnimalStatus;
  herdName: string | null;
  currentWeightKg: number | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  agreedPrice: number | null;
  reservedUntil: string;
  status: ReservationStatus;
  note: string | null;
  saleId: string | null;
  saleNumber: string | null;
  requestId: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdAt: string;
  /** First day the animal may leave the farm after a treatment. Null: no withdrawal in force. */
  withdrawalUntil: string | null;
}

/** An animal the farm shows on its public page. */
export interface Listing {
  id: string;
  animalId: string;
  animalTag: string;
  animalCategory: string;
  animalSex: 'female' | 'male';
  animalStatus: AnimalStatus;
  herdName: string | null;
  currentWeightKg: number | null;
  price: number | null;
  createdAt: string;
}

export interface RequestedAnimal {
  animalId: string;
  tag: string;
  status: AnimalStatus;
  reserved: boolean;
}

/** A pre-order from the public page. What the visitor typed is shown as text, never acted on. */
export interface CatalogueRequest {
  id: string;
  name: string | null;
  phone: string | null;
  wanted: string | null;
  note: string | null;
  language: string;
  status: CatalogueRequestStatus;
  submissions: number;
  closedAt: string | null;
  createdAt: string;
  animals: RequestedAnimal[];
}
