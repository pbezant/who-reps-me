import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportBug from './ReportBug';

afterEach(() => {
  delete global.fetch;
});

test('renders only the floating button until clicked', () => {
  render(<ReportBug />);
  expect(screen.getByRole('button', { name: /help us grow this map/i })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('opens the dialog on click, focused on the link field', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText(/link to where you saw it/i)).toHaveFocus();
});

test('Escape closes the dialog', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the submit button stays disabled with no note entered, even with a link', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/link to where you saw it/i), { target: { value: 'https://example.gov/council' } });
  expect(screen.getByRole('button', { name: /send it in/i })).toBeDisabled();
});

test('the link field is optional — a note alone enables submit', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/what's missing or wrong/i), { target: { value: 'The mayor shown is wrong' } });
  expect(screen.getByRole('button', { name: /send it in/i })).not.toBeDisabled();
});

test('submits the note, link, and page/search context to /api/report-bug', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ status: 'found', message: "Thanks for the help! We'll get it added.", issueUrl: 'https://github.com/pbezant/who-reps-me/issues/7' }),
    })
  );
  const repList = { geo: { place: 'Elgin', county: null, state: 'TX' } };
  render(<ReportBug repList={repList} />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/link to where you saw it/i), { target: { value: 'https://www.elgintx.com/149/City-Council' } });
  fireEvent.change(screen.getByLabelText(/what's missing or wrong/i), { target: { value: 'The mayor shown is wrong' } });
  fireEvent.click(screen.getByRole('button', { name: /send it in/i }));

  await waitFor(() => expect(screen.getByText(/thanks for the help/i)).toBeInTheDocument());

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [calledUrl, options] = global.fetch.mock.calls[0];
  expect(calledUrl).toBe('/api/report-bug');
  const sentBody = JSON.parse(options.body);
  expect(sentBody.note).toBe('The mayor shown is wrong');
  expect(sentBody.url).toBe('https://www.elgintx.com/149/City-Council');
  expect(sentBody.context.search).toEqual({ place: 'Elgin', county: null, state: 'TX' });

  expect(screen.getByRole('link', { name: /view the issue/i })).toHaveAttribute(
    'href',
    'https://github.com/pbezant/who-reps-me/issues/7'
  );
});

test('submits an empty url when no link was entered', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ status: 'found', message: 'Thanks!' }) }));
  render(<ReportBug repList={null} />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/what's missing or wrong/i), { target: { value: 'Page is blank' } });
  fireEvent.click(screen.getByRole('button', { name: /send it in/i }));

  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(sentBody.url).toBe('');
  expect(sentBody.context.search).toBeNull();
});

test('shows the backend error message on a validation/rate-limit failure', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, status: 429, json: async () => ({ error: "You've submitted a lot of these today — try again tomorrow." }) })
  );
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/what's missing or wrong/i), { target: { value: 'Something is off' } });
  fireEvent.click(screen.getByRole('button', { name: /send it in/i }));

  await waitFor(() => expect(screen.getByText(/submitted a lot of these today/i)).toBeInTheDocument());
});

test('shows a network-failure message when the request itself throws', async () => {
  global.fetch = jest.fn(() => Promise.reject(new Error('network down')));
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/what's missing or wrong/i), { target: { value: 'Something is off' } });
  fireEvent.click(screen.getByRole('button', { name: /send it in/i }));

  await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());
});

test('reopening after a submission starts from a blank form', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ status: 'found', message: 'Thanks!' }) }));
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  fireEvent.change(screen.getByLabelText(/link to where you saw it/i), { target: { value: 'https://example.gov/council' } });
  fireEvent.change(screen.getByLabelText(/what's missing or wrong/i), { target: { value: 'Something is off' } });
  fireEvent.click(screen.getByRole('button', { name: /send it in/i }));
  await waitFor(() => expect(screen.getByText(/^thanks!$/i)).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  fireEvent.click(screen.getByRole('button', { name: /help us grow this map/i }));
  expect(screen.getByLabelText(/link to where you saw it/i)).toHaveValue('');
  expect(screen.getByLabelText(/what's missing or wrong/i)).toHaveValue('');
});
