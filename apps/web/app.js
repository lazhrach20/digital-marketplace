const API_BASE = 'http://localhost:3000/api';

(function initCatalogDropdown() {
  const button = document.getElementById('catalog-button');
  const dropdown = document.getElementById('catalog-dropdown');

  if (!button || !dropdown) {
    return;
  }

  const categories = Array.from(
    dropdown.querySelectorAll('.catalog-dropdown__category')
  );

  function isOpen() {
    return button.getAttribute('aria-expanded') === 'true';
  }

  function openDropdown() {
    dropdown.hidden = false;
    dropdown.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown() {
    dropdown.hidden = true;
    dropdown.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
  }

  function toggleDropdown() {
    if (isOpen()) {
      closeDropdown();
    } else {
      openDropdown();
    }
  }

  button.addEventListener('click', function (event) {
    event.stopPropagation();
    toggleDropdown();
  });

  document.addEventListener('click', function (event) {
    if (!isOpen()) {
      return;
    }

    if (dropdown.contains(event.target) || button.contains(event.target)) {
      return;
    }

    closeDropdown();
  });

  categories.forEach(function (category) {
    category.addEventListener('click', function () {
      categories.forEach(function (item) {
        item.classList.toggle(
          'catalog-dropdown__category--active',
          item === category
        );
      });
    });
  });
})();

(function initHeroCarousel() {
  const track = document.getElementById('hero-carousel-track');
  const prevBtn = document.getElementById('hero-carousel-prev');
  const nextBtn = document.getElementById('hero-carousel-next');
  const dotsRoot = document.getElementById('hero-carousel-dots');

  if (!track || !prevBtn || !nextBtn || !dotsRoot) {
    return;
  }

  const slides = Array.from(track.querySelectorAll('.hero-carousel__slide'));
  const dots = Array.from(dotsRoot.querySelectorAll('.hero-carousel__dot'));
  const total = slides.length;
  let current = 0;
  let timerId = null;
  const AUTO_INTERVAL_MS = 5000;

  function goTo(index) {
    const nextIndex = ((index % total) + total) % total;
    current = nextIndex;

    track.style.transform = 'translateX(-' + nextIndex * 100 + '%)';

    slides.forEach(function (slide, i) {
      slide.setAttribute('aria-hidden', i === nextIndex ? 'false' : 'true');
    });

    dots.forEach(function (dot, i) {
      const isActive = i === nextIndex;
      dot.classList.toggle('hero-carousel__dot--active', isActive);
      dot.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  function next() {
    goTo(current + 1);
  }

  function prev() {
    goTo(current - 1);
  }

  function startAuto() {
    stopAuto();
    timerId = window.setInterval(next, AUTO_INTERVAL_MS);
  }

  function stopAuto() {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  prevBtn.addEventListener('click', function () {
    prev();
    startAuto();
  });

  nextBtn.addEventListener('click', function () {
    next();
    startAuto();
  });

  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      const index = Number(dot.getAttribute('data-index'));
      if (!Number.isNaN(index)) {
        goTo(index);
        startAuto();
      }
    });
  });

  const viewport = track.closest('.hero-carousel__viewport');
  if (viewport) {
    viewport.addEventListener('mouseenter', stopAuto);
    viewport.addEventListener('mouseleave', startAuto);
    viewport.addEventListener('focusin', stopAuto);
    viewport.addEventListener('focusout', startAuto);
  }

  goTo(0);
  startAuto();
})();

const FALLBACK_PRODUCTS = [
  {
    sku: 'STEAM-TOPUP-500',
    name: 'Пополнение Steam 500 ₽',
    price: 500,
    currency: 'RUB',
    image: 'assets/steam.png',
  },
  {
    sku: 'STEAM-TOPUP-1000',
    name: 'Пополнение Steam 1000 ₽',
    price: 1000,
    currency: 'RUB',
    image: 'assets/steam.png',
  },
  {
    sku: 'STEAM-TOPUP-2500',
    name: 'Пополнение Steam 2500 ₽',
    price: 2500,
    currency: 'RUB',
    image: 'assets/steam.png',
  },
  {
    sku: 'KEY-CS2-PRIME',
    name: 'CS2 Prime Status ключ',
    price: 1290,
    currency: 'RUB',
    image: 'assets/cs2.png',
  },
  {
    sku: 'KEY-GTA5',
    name: 'GTA V ключ активации',
    price: 1990,
    currency: 'RUB',
    image: 'assets/gta5.png',
  },
];

function formatProductPrice(price, currency) {
  const formatted = new Intl.NumberFormat('ru-RU').format(price);
  if (currency === 'RUB') {
    return formatted + ' ₽';
  }
  return formatted + ' ' + currency;
}

function decorativeOldPrice(price) {
  return Math.round(price * 1.5);
}

function createPopularProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';
  card.setAttribute('role', 'listitem');
  card.dataset.sku = product.sku;

  const cover = document.createElement('div');
  cover.className = 'product-card__cover';

  const image = document.createElement('img');
  image.src = product.image || 'assets/steam.png';
  image.alt = '';
  image.width = 203;
  image.height = 152;
  image.addEventListener('error', function () {
    image.src = 'assets/steam.png';
  });
  cover.appendChild(image);

  const title = document.createElement('h3');
  title.className = 'product-card__title';
  title.textContent = product.name;

  const prices = document.createElement('div');
  prices.className = 'product-card__prices';

  const currentPrice = document.createElement('span');
  currentPrice.className = 'product-card__price';
  currentPrice.textContent = formatProductPrice(product.price, product.currency);

  const oldPrice = document.createElement('span');
  oldPrice.className = 'product-card__price-old';
  oldPrice.textContent = formatProductPrice(
    decorativeOldPrice(product.price),
    product.currency
  );

  prices.appendChild(currentPrice);
  prices.appendChild(oldPrice);

  const buyButton = document.createElement('button');
  buyButton.type = 'button';
  buyButton.className = 'product-card__buy';
  buyButton.textContent = 'Купить';
  buyButton.addEventListener('click', function () {
    startOrder(product.sku, buyButton);
  });

  card.appendChild(cover);
  card.appendChild(title);
  card.appendChild(prices);
  card.appendChild(buyButton);

  return card;
}

function renderPopularProducts(products) {
  const grid = document.getElementById('popular-products-grid');
  if (!grid) {
    return;
  }

  grid.replaceChildren();

  products.slice(0, 5).forEach(function (product) {
    grid.appendChild(createPopularProductCard(product));
  });
}

async function fetchPopularProducts() {
  try {
    const response = await fetch(API_BASE + '/products');
    if (!response.ok) {
      throw new Error('Products request failed');
    }
    const products = await response.json();
    if (!Array.isArray(products) || products.length === 0) {
      return FALLBACK_PRODUCTS;
    }
    return products;
  } catch (_error) {
    return FALLBACK_PRODUCTS;
  }
}

async function startOrder(sku, button) {
  button.disabled = true;

  try {
    const response = await fetch(API_BASE + '/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: sku }),
    });

    if (!response.ok) {
      throw new Error('Order request failed');
    }

    const order = await response.json();
    window.location.href =
      'order.html?id=' + encodeURIComponent(order.id);
  } catch (_error) {
    button.disabled = false;
  }
}

(function initPopularProducts() {
  const section = document.getElementById('popular-products');
  const grid = document.getElementById('popular-products-grid');
  if (!section || !grid) {
    return;
  }

  const chips = Array.from(
    section.querySelectorAll('.product-rail__chip')
  );

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (item) {
        item.classList.toggle('product-rail__chip--active', item === chip);
      });
    });
  });

  fetchPopularProducts().then(function (products) {
    renderPopularProducts(products);
  });
})();

(function initSteamCurrency() {
  const root = document.getElementById('steam-topup');
  if (!root) {
    return;
  }

  const chips = Array.from(root.querySelectorAll('.steam-topup__currency'));
  if (!chips.length) {
    return;
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (item) {
        const isActive = item === chip;
        item.classList.toggle('steam-topup__currency--active', isActive);
        item.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    });
  });
})();
