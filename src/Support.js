import React from 'react';

// Ways for visitors to chip in and support the project. Deliberately backend-free:
//   - Stripe: a hosted Payment Link (buy.stripe.com/...) — Stripe hosts the whole payment
//     page, so no API keys, no serverless function, and no PCI scope live in this repo. Swap
//     the test link below for the live one (created while the Stripe Dashboard is in Live
//     mode) before launch.
//   - Venmo: a deep link to the profile. On mobile it opens the app; on desktop it opens the
//     web profile.
//
// Note: this is a personal project, not a registered 501(c)(3), so copy says "support" rather
// than implying a tax-deductible charitable donation.

// Live Stripe Payment Link for the "Support Who Reps Me" product (customer-chosen amount).
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/fZu28q1PkaaU1Hc8gf93y00';

const VENMO_USERNAME = 'prestonbezant';
const VENMO_URL = `https://venmo.com/u/${VENMO_USERNAME}`;

export default function Support() {
  return (
    <footer className="support" aria-label="Support this project">
      <span className="support-label">Support this project:</span>
      <a
        className="support-link"
        href={STRIPE_PAYMENT_LINK}
        target="_blank"
        rel="noopener noreferrer"
      >
        Card
      </a>
      <span className="support-sep" aria-hidden="true">·</span>
      <a
        className="support-link"
        href={VENMO_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Venmo
      </a>
    </footer>
  );
}
