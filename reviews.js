(() => {
  'use strict';

  const root = document.querySelector('[data-reviews-root]');
  if (!root) return;

  const API_URL = '/api/reviews';
  const MAX_PHOTO_SIZE = 5 * 1024 * 1024;
  const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
  const ALLOWED_PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i;
  const modal = root.querySelector('[data-review-modal]');
  const panel = modal?.querySelector('.review-modal__panel');
  const modalTitle = modal?.querySelector('#review-modal-title');
  const formView = modal?.querySelector('[data-review-form-view]');
  const successView = modal?.querySelector('[data-review-success-view]');
  const successTitle = modal?.querySelector('[data-review-success-title]');
  const form = modal?.querySelector('[data-review-form]');
  const submitButton = modal?.querySelector('[data-review-submit]');
  const submitLabel = modal?.querySelector('[data-review-submit-label]');
  const submitStatus = modal?.querySelector('[data-review-submit-status]');
  const photoInput = modal?.querySelector('[data-review-photo]');
  const photoPreview = modal?.querySelector('[data-photo-preview]');
  const previewImage = modal?.querySelector('[data-photo-preview-image]');
  const photoName = modal?.querySelector('[data-photo-name]');
  const photoError = modal?.querySelector('[data-photo-error]');
  const removePhoto = modal?.querySelector('[data-remove-photo]');
  const turnstileContainer = modal?.querySelector('[data-review-turnstile]');
  const ratingInputs = [...(modal?.querySelectorAll('input[name="rating"]') || [])];
  const starLabels = [...(modal?.querySelectorAll('[data-star-label]') || [])];
  const ratingOutput = modal?.querySelector('[data-rating-output]');
  const loading = root.querySelector('[data-reviews-loading]');
  const list = root.querySelector('[data-reviews-list]');
  const empty = root.querySelector('[data-reviews-empty]');
  const error = root.querySelector('[data-reviews-error]');
  const announcer = root.querySelector('[data-reviews-announcer]');
  let returnFocusTo = null;
  let previewUrl = '';
  let turnstileWidgetId = null;

  const hide = (element, value) => { if (element) element.hidden = value; };
  const setListState = (state) => {
    hide(loading, state !== 'loading');
    hide(list, state !== 'ready');
    hide(empty, state !== 'empty');
    hide(error, state !== 'error');
  };

  const makeRating = (rating) => {
    const element = document.createElement('div');
    element.className = 'review-card__rating';
    element.setAttribute('aria-label', `${rating} out of 5 stars`);
    for (let index = 1; index <= 5; index += 1) {
      const star = document.createElement('span');
      star.setAttribute('aria-hidden', 'true');
      star.textContent = index <= rating ? '★' : '☆';
      if (index > rating) star.className = 'is-empty';
      element.appendChild(star);
    }
    return element;
  };

  const normaliseReview = (item) => {
    if (!item || typeof item !== 'object') return null;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const text = typeof item.review === 'string' ? item.review.trim() : '';
    const rating = Math.round(Number(item.rating));
    const photoUrl = typeof item.photoUrl === 'string' ? item.photoUrl.trim() : '';
    const approvedAt = typeof item.approvedAt === 'string' ? item.approvedAt.trim() : '';
    if (!name || !text || rating < 1 || rating > 5) return null;
    return { name, text, rating, photoUrl, approvedAt };
  };

  const safePhotoUrl = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && url.pathname.startsWith('/api/review-images/') ? url.href : '';
    } catch (_error) { return ''; }
  };

  const makeCard = (review, index) => {
    const card = document.createElement('article');
    card.className = 'review-card';
    const titleId = `review-card-name-${index + 1}`;
    card.setAttribute('aria-labelledby', titleId);
    card.appendChild(makeRating(review.rating));

    const text = document.createElement('p');
    text.className = 'review-card__text';
    text.textContent = review.text;
    card.appendChild(text);

    const imageUrl = safePhotoUrl(review.photoUrl);
    if (imageUrl) {
      const figure = document.createElement('figure');
      figure.className = 'review-card__photo';
      const image = document.createElement('img');
      image.src = imageUrl;
      image.alt = `Photo shared with ${review.name}'s review`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      figure.appendChild(image);
      card.appendChild(figure);
    }

    const footer = document.createElement('footer');
    footer.className = 'review-card__footer';
    const name = document.createElement('h3');
    name.className = 'review-card__name';
    name.id = titleId;
    name.textContent = review.name;
    footer.appendChild(name);
    const date = new Date(review.approvedAt);
    if (review.approvedAt && !Number.isNaN(date.getTime())) {
      const time = document.createElement('time');
      time.className = 'review-card__date';
      time.dateTime = date.toISOString();
      time.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(date);
      footer.appendChild(time);
    }
    card.appendChild(footer);
    return card;
  };

  const setupTurnstile = (siteKey) => {
    if (!siteKey || !turnstileContainer || window.turnstile || document.querySelector('script[data-review-turnstile-script]')) return;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.reviewTurnstileScript = '';
    script.addEventListener('load', () => {
      hide(turnstileContainer, false);
      turnstileWidgetId = window.turnstile.render(turnstileContainer, {
        sitekey: siteKey,
        action: 'review-submit',
        theme: 'light',
      });
    }, { once: true });
    document.head.appendChild(script);
  };

  const loadReviews = async () => {
    setListState('loading');
    try {
      const response = await fetch(API_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!response.ok) throw new Error('Review service unavailable');
      const payload = await response.json();
      setupTurnstile(typeof payload.turnstileSiteKey === 'string' ? payload.turnstileSiteKey : '');
      const reviews = Array.isArray(payload.reviews) ? payload.reviews.map(normaliseReview).filter(Boolean) : [];
      list.replaceChildren(...reviews.map(makeCard));
      setListState(reviews.length ? 'ready' : 'empty');
      announcer.textContent = reviews.length ? `${reviews.length} customer ${reviews.length === 1 ? 'review' : 'reviews'} loaded.` : 'There are no published customer reviews yet.';
    } catch (_error) {
      setListState('error');
      announcer.textContent = 'Customer reviews could not be loaded.';
    }
  };

  const focusable = () => [...panel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden && element.getClientRects().length);
  const clearPhoto = (clearInput = true) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    if (clearInput) photoInput.value = '';
    previewImage.removeAttribute('src');
    photoName.textContent = '';
    photoError.textContent = '';
    hide(photoPreview, true);
  };
  const updateRating = (preview = null) => {
    const checked = ratingInputs.find((input) => input.checked);
    const selected = checked ? Number(checked.value) : 0;
    const visible = preview === null ? selected : preview;
    starLabels.forEach((label) => label.classList.toggle('is-filled', Number(label.dataset.rating) <= visible));
    ratingOutput.value = selected ? `${selected} out of 5` : 'Not selected';
    ratingOutput.textContent = ratingOutput.value;
  };
  const resetView = () => {
    hide(formView, false);
    hide(successView, true);
    submitStatus.textContent = '';
    submitStatus.classList.remove('is-error');
  };
  const openModal = (trigger) => {
    returnFocusTo = trigger || document.activeElement;
    if (!successView.hidden) { form.reset(); clearPhoto(); updateRating(); resetView(); }
    modal.hidden = false;
    document.body.classList.add('review-dialog-open');
    requestAnimationFrame(() => modalTitle.focus());
  };
  const closeModal = () => {
    if (modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('review-dialog-open');
    if (returnFocusTo?.focus && document.contains(returnFocusTo)) returnFocusTo.focus();
    returnFocusTo = null;
  };

  root.addEventListener('click', (event) => {
    const open = event.target.closest('[data-open-review-modal]');
    const close = event.target.closest('[data-close-review-modal]');
    if (open) openModal(open);
    if (close || event.target === modal) closeModal();
    if (event.target.closest('[data-reviews-retry]')) loadReviews();
  });
  document.addEventListener('keydown', (event) => {
    if (modal.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) { event.preventDefault(); modalTitle.focus(); return; }
    const lastItem = items[items.length - 1];
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); lastItem.focus(); }
    else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); items[0].focus(); }
  });

  ratingInputs.forEach((input) => input.addEventListener('change', () => updateRating()));
  starLabels.forEach((label) => {
    label.addEventListener('mouseenter', () => updateRating(Number(label.dataset.rating)));
    label.addEventListener('mouseleave', () => updateRating());
  });
  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    clearPhoto(false);
    if (!file) return;
    if (!ALLOWED_PHOTO_TYPES.has(file.type) && !ALLOWED_PHOTO_EXTENSIONS.test(file.name)) { photoInput.value = ''; photoError.textContent = 'Please choose a JPG, PNG, WebP or HEIC image.'; return; }
    if (file.size > MAX_PHOTO_SIZE) { photoInput.value = ''; photoError.textContent = 'That image is over 5 MB. Please choose a smaller file.'; return; }
    previewUrl = URL.createObjectURL(file);
    previewImage.src = previewUrl;
    photoName.textContent = file.name;
    hide(photoPreview, false);
  });
  removePhoto.addEventListener('click', () => { clearPhoto(); photoInput.focus(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    submitLabel.textContent = 'Sending…';
    submitStatus.textContent = '';
    submitStatus.classList.remove('is-error');
    try {
      const response = await fetch(API_URL, { method: 'POST', headers: { Accept: 'application/json' }, body: new FormData(form), credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const publicError = response.status >= 500
          ? 'We could not send your review right now. Please try again shortly.'
          : (payload.error || 'We could not send your review right now.');
        throw new Error(publicError);
      }
      hide(formView, true);
      hide(successView, false);
      clearPhoto();
      if (!modal.hidden) successTitle.focus();
      if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
    } catch (requestError) {
      submitStatus.classList.add('is-error');
      submitStatus.textContent = requestError.message || 'We could not send your review right now. Please try again.';
      if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
      submitLabel.textContent = 'Send review';
      if (submitStatus.classList.contains('is-error') && !modal.hidden) submitButton.focus();
    }
  });

  updateRating();
  loadReviews();
})();
