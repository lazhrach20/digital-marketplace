const API_BASE = 'http://localhost:3000/api';
const POLL_INTERVAL_MS = 1500;

const STATUS_LABELS = {
  created: 'Создан',
  paid: 'Оплачен',
  delivering: 'Выдаётся',
  delivered: 'Выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Нет в наличии',
  delivery_failed: 'Ошибка выдачи',
};

const STATUS_MESSAGES = {
  out_of_stock:
    'Оплата прошла, но ключи закончились. После пополнения склада нажмите «Повторить выдачу».',
  payment_failed:
    'Оплата не прошла. Вернитесь в каталог и создайте новый заказ.',
  delivery_failed:
    'Не удалось выдать товар автоматически. Нажмите «Повторить выдачу» для повторной попытки.',
};

const RETRY_STATUSES = ['out_of_stock', 'delivery_failed', 'delivering'];
const POLL_STATUSES = ['paid', 'delivering'];

let pollTimerId = null;
let busy = false;

function getOrderIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  return id && id.trim() !== '' ? id.trim() : null;
}

function formatAmount(amount, currency) {
  const formatted = new Intl.NumberFormat('ru-RU').format(amount);
  if (currency === 'RUB') {
    return formatted + ' ₽';
  }
  return formatted + ' ' + currency;
}

function stopPolling() {
  if (pollTimerId !== null) {
    window.clearInterval(pollTimerId);
    pollTimerId = null;
  }
}

function startPolling(orderId) {
  stopPolling();
  pollTimerId = window.setInterval(function () {
    loadOrder(orderId, { silent: true });
  }, POLL_INTERVAL_MS);
}

function setBusy(nextBusy) {
  busy = nextBusy;
  const buttons = document.querySelectorAll('.order-page__btn');
  buttons.forEach(function (button) {
    button.disabled = nextBusy;
  });
}

function showFatalError(message) {
  const loadingEl = document.getElementById('order-loading');
  const errorEl = document.getElementById('order-error');
  const cardEl = document.getElementById('order-card');

  if (loadingEl) {
    loadingEl.hidden = true;
  }
  if (errorEl) {
    errorEl.hidden = false;
    errorEl.textContent = message;
  }
  if (cardEl) {
    cardEl.hidden = true;
  }
}

function showActionError(message) {
  const messageEl = document.getElementById('order-message');
  if (!messageEl) {
    return;
  }

  messageEl.hidden = false;
  messageEl.className = 'order-page__message order-page__message--error';
  messageEl.textContent = message;
}

function renderStatusBadge(status) {
  const badgeRoot = document.getElementById('order-status-badge');
  if (!badgeRoot) {
    return;
  }

  badgeRoot.replaceChildren();
  const badge = document.createElement('span');
  badge.className =
    'order-page__status order-page__status--' + status;
  badge.textContent = STATUS_LABELS[status] || status;
  badgeRoot.appendChild(badge);
}

function renderMessage(status) {
  const messageEl = document.getElementById('order-message');
  if (!messageEl) {
    return;
  }

  const text = STATUS_MESSAGES[status];
  if (!text) {
    messageEl.hidden = true;
    messageEl.replaceChildren();
    return;
  }

  messageEl.hidden = false;
  messageEl.className =
    'order-page__message ' +
    (status === 'out_of_stock'
      ? 'order-page__message--warning'
      : 'order-page__message--error');
  messageEl.textContent = text;
}

function renderCode(code) {
  const blockEl = document.getElementById('order-code-block');
  if (!blockEl) {
    return;
  }

  if (!code) {
    blockEl.hidden = true;
    blockEl.replaceChildren();
    return;
  }

  blockEl.hidden = false;
  blockEl.replaceChildren();

  const label = document.createElement('span');
  label.className = 'order-page__label';
  label.textContent = 'Ваш код';

  const codeEl = document.createElement('code');
  codeEl.className = 'order-page__code';
  codeEl.textContent = code;

  blockEl.appendChild(label);
  blockEl.appendChild(codeEl);
}

function renderActions(order) {
  const actionsEl = document.getElementById('order-actions');
  if (!actionsEl) {
    return;
  }

  actionsEl.replaceChildren();

  if (order.status === 'created') {
    const successBtn = document.createElement('button');
    successBtn.type = 'button';
    successBtn.className =
      'order-page__btn order-page__btn--primary';
    successBtn.textContent = 'Оплатить успешно';
    successBtn.addEventListener('click', function () {
      simulatePayment(order.id, 'paid');
    });

    const failBtn = document.createElement('button');
    failBtn.type = 'button';
    failBtn.className =
      'order-page__btn order-page__btn--secondary';
    failBtn.textContent = 'Оплатить неуспешно';
    failBtn.addEventListener('click', function () {
      simulatePayment(order.id, 'failed');
    });

    actionsEl.appendChild(successBtn);
    actionsEl.appendChild(failBtn);
    return;
  }

  if (RETRY_STATUSES.indexOf(order.status) !== -1) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className =
      'order-page__btn order-page__btn--primary';
    retryBtn.textContent = 'Повторить выдачу';
    retryBtn.addEventListener('click', function () {
      retryDelivery(order.id);
    });
    actionsEl.appendChild(retryBtn);
  }
}

function renderOrder(order) {
  const loadingEl = document.getElementById('order-loading');
  const errorEl = document.getElementById('order-error');
  const stateEl = document.getElementById('order-state');
  const cardEl = document.getElementById('order-card');
  const idEl = document.getElementById('order-id');
  const skuEl = document.getElementById('order-sku');
  const amountEl = document.getElementById('order-amount');

  if (loadingEl) {
    loadingEl.hidden = true;
  }
  if (errorEl) {
    errorEl.hidden = true;
  }
  if (stateEl) {
    stateEl.hidden = true;
  }
  if (cardEl) {
    cardEl.hidden = false;
  }
  if (idEl) {
    idEl.textContent = order.id;
  }
  if (skuEl) {
    skuEl.textContent = order.sku;
  }
  if (amountEl) {
    amountEl.textContent = formatAmount(order.amount, order.currency);
  }

  renderStatusBadge(order.status);
  renderMessage(order.status);
  renderCode(order.code);
  renderActions(order);

  if (POLL_STATUSES.indexOf(order.status) !== -1) {
    startPolling(order.id);
  } else {
    stopPolling();
  }
}

async function fetchOrder(orderId) {
  const response = await fetch(API_BASE + '/orders/' + encodeURIComponent(orderId));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Заказ не найден');
    }
    throw new Error('Не удалось загрузить заказ');
  }
  return response.json();
}

async function loadOrder(orderId, options) {
  const silent = options && options.silent;

  if (!silent) {
    setBusy(true);
  }

  try {
    const order = await fetchOrder(orderId);
    renderOrder(order);
  } catch (error) {
    if (!silent) {
      showFatalError(
        error instanceof Error ? error.message : 'Не удалось загрузить заказ'
      );
      stopPolling();
    }
  } finally {
    if (!silent) {
      setBusy(false);
    }
  }
}

async function simulatePayment(orderId, status) {
  if (busy) {
    return;
  }

  setBusy(true);

  try {
    const response = await fetch(
      API_BASE + '/orders/' + encodeURIComponent(orderId) + '/simulate-payment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status }),
      }
    );

    if (!response.ok) {
      throw new Error('Не удалось эмулировать оплату');
    }

    await loadOrder(orderId);
  } catch (error) {
    showActionError(
      error instanceof Error ? error.message : 'Не удалось эмулировать оплату'
    );
  } finally {
    setBusy(false);
  }
}

async function retryDelivery(orderId) {
  if (busy) {
    return;
  }

  setBusy(true);

  try {
    const response = await fetch(
      API_BASE + '/orders/' + encodeURIComponent(orderId) + '/retry-delivery',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!response.ok) {
      if (response.status === 409) {
        throw new Error('Повторная выдача недоступна для текущего статуса');
      }
      throw new Error('Не удалось повторить выдачу');
    }

    const order = await response.json();
    renderOrder(order);

    if (POLL_STATUSES.indexOf(order.status) !== -1) {
      startPolling(orderId);
    }
  } catch (error) {
    showActionError(
      error instanceof Error ? error.message : 'Не удалось повторить выдачу'
    );
  } finally {
    setBusy(false);
  }
}

(function initOrderPage() {
  const orderId = getOrderIdFromQuery();

  if (!orderId) {
    showFatalError('Не указан идентификатор заказа (?id=...)');
    return;
  }

  loadOrder(orderId);

  window.addEventListener('beforeunload', stopPolling);
})();
