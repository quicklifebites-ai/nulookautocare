(() => {
  'use strict';

  const header = document.querySelector('[data-header]');
  const navToggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('#primary-nav');
  const navLinks = nav ? [...nav.querySelectorAll('a')] : [];

  const updateHeader = () => {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 18);
  };

  const setMenu = (open) => {
    if (!navToggle || !nav || !header) return;
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.querySelector('.sr-only').textContent = open ? 'Close menu' : 'Open menu';
    nav.classList.toggle('is-open', open);
    header.classList.toggle('is-menu-open', open);
    document.body.classList.toggle('menu-open', open);
  };

  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      setMenu(navToggle.getAttribute('aria-expanded') !== 'true');
    });

    navLinks.forEach((link) => link.addEventListener('click', () => setMenu(false)));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
        setMenu(false);
        navToggle.focus();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 740) setMenu(false);
    });
  }

  const slider = document.querySelector('[data-slider]');

  if (slider) {
    const slides = [...slider.querySelectorAll('[data-slide]')];
    const dots = [...slider.querySelectorAll('[data-dot]')];
    const previousButton = slider.querySelector('[data-prev]');
    const nextButton = slider.querySelector('[data-next]');
    const pauseButton = slider.querySelector('[data-pause]');
    const pauseIcon = slider.querySelector('[data-pause-icon]');
    const pauseLabel = slider.querySelector('[data-pause-label]');
    const status = slider.querySelector('[data-status]');
    const visibleStatus = slider.querySelector('[data-visible-status]');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const interval = 4000;
    let activeIndex = 0;
    let timer = null;
    let pausedByUser = reduceMotion.matches;

    const prepareImage = (index) => {
      const slide = slides[(index + slides.length) % slides.length];
      const image = slide?.querySelector('img');
      if (!image) return;
      image.loading = 'eager';
      if (typeof image.decode === 'function') image.decode().catch(() => {});
    };

    const render = (nextIndex, announce = true) => {
      activeIndex = (nextIndex + slides.length) % slides.length;

      slides.forEach((slide, index) => {
        const active = index === activeIndex;
        slide.classList.toggle('is-active', active);
        slide.setAttribute('aria-hidden', String(!active));
      });

      dots.forEach((dot, index) => {
        const active = index === activeIndex;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-pressed', String(active));
      });

      if (announce && status) status.textContent = `Image ${activeIndex + 1} of ${slides.length}`;
      if (visibleStatus) visibleStatus.textContent = `${activeIndex + 1} / ${slides.length}`;
      prepareImage(activeIndex + 1);
    };

    const stopTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const startTimer = () => {
      stopTimer();
      if (!pausedByUser && !document.hidden) {
        timer = window.setInterval(() => render(activeIndex + 1, false), interval);
      }
    };

    const resetTimer = () => startTimer();

    const updatePauseButton = () => {
      if (!pauseButton || !pauseIcon || !pauseLabel) return;
      pauseButton.setAttribute('aria-pressed', String(pausedByUser));
      pauseIcon.textContent = pausedByUser ? '▶' : 'Ⅱ';
      pauseLabel.textContent = pausedByUser ? 'Play' : 'Pause';
      pauseButton.setAttribute('aria-label', pausedByUser ? 'Play slideshow' : 'Pause slideshow');
    };

    previousButton?.addEventListener('click', () => {
      render(activeIndex - 1);
      resetTimer();
    });

    nextButton?.addEventListener('click', () => {
      render(activeIndex + 1);
      resetTimer();
    });

    dots.forEach((dot) => {
      dot.addEventListener('click', () => {
        render(Number(dot.dataset.dot));
        resetTimer();
      });
    });

    pauseButton?.addEventListener('click', () => {
      pausedByUser = !pausedByUser;
      updatePauseButton();
      startTimer();
    });

    slider.addEventListener('keydown', (event) => {
      const tagName = event.target.tagName;
      const isFormControl = tagName === 'BUTTON' || tagName === 'A' || tagName === 'INPUT';

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        render(activeIndex - 1);
        resetTimer();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        render(activeIndex + 1);
        resetTimer();
      } else if (event.key === 'Home') {
        event.preventDefault();
        render(0);
        resetTimer();
      } else if (event.key === 'End') {
        event.preventDefault();
        render(slides.length - 1);
        resetTimer();
      } else if (event.key === ' ' && !isFormControl) {
        event.preventDefault();
        pausedByUser = !pausedByUser;
        updatePauseButton();
        startTimer();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopTimer();
      else startTimer();
    });

    const handleMotionPreference = () => {
      if (reduceMotion.matches) {
        pausedByUser = true;
        stopTimer();
      }
      updatePauseButton();
      startTimer();
    };

    if (typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', handleMotionPreference);
    } else if (typeof reduceMotion.addListener === 'function') {
      reduceMotion.addListener(handleMotionPreference);
    }

    render(0, false);
    updatePauseButton();
    startTimer();
  }

  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();
