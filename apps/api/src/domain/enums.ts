export enum OrderStatus {
  created = 'created',
  paid = 'paid',
  delivering = 'delivering',
  delivered = 'delivered',
  payment_failed = 'payment_failed',
  out_of_stock = 'out_of_stock',
  delivery_failed = 'delivery_failed',
}

export enum ProductType {
  topup = 'topup',
  key = 'key',
  subscription = 'subscription',
  giftcard = 'giftcard',
}

export enum ProviderId {
  A = 'A',
  B = 'B',
}

export enum PaymentStatus {
  paid = 'paid',
  failed = 'failed',
}

export enum FulfillmentOutcome {
  ok = 'ok',
  timeout = 'timeout',
  error = 'error',
  out_of_stock = 'out_of_stock',
}
