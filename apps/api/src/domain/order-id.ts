import { nanoid } from 'nanoid';

const ORDER_ID_PREFIX = 'ord_';
const ORDER_ID_PATTERN = /^ord_[A-Za-z0-9_-]+$/;

export function generateOrderId(): string {
  return `${ORDER_ID_PREFIX}${nanoid()}`;
}

export function isValidOrderId(id: string): boolean {
  return ORDER_ID_PATTERN.test(id);
}
