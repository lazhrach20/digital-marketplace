const API_BASE = 'http://localhost:3000/api';

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
