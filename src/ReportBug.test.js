import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReportBug from './ReportBug';

afterEach(() => {
  delete global.fetch;
});

test('renders only the floating button until clicked', () => {
  render(<ReportBug />);
  expect(screen.getByRole('button', { name: /report a bug/i })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('opens the dialog on click, focused on the description field', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText(/what went wrong/i)).toHaveFocus();
});

test('Escape closes the dialog', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the submit button stays disabled with no description entered', () => {
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
});

test('submits the description plus page/search context to /api/report-bug', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ status: 'found', message: 'Thanks! We filed this.', issueUrl: 'https://github.com/pbezant/who-reps-me/issues/7' }),
    })
  );
  const repList = { geo: { place: 'Elgin', county: null, state: 'TX' } };
  render(<ReportBug repList={repList} />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  fireEvent.change(screen.getByLabelText(/what went wrong/i), { target: { value: 'The mayor shown is wrong' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(screen.getByText(/thanks! we filed this/i)).toBeInTheDocument());

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('/api/report-bug');
  const sentBody = JSON.parse(options.body);
  expect(sentBody.description).toBe('The mayor shown is wrong');
  expect(sentBody.context.search).toEqual({ place: 'Elgin', county: null, state: 'TX' });

  expect(screen.getByRole('link', { name: /view the issue/i })).toHaveAttribute(
    'href',
    'https://github.com/pbezant/who-reps-me/issues/7'
  );
});

test('omits search context when no search has run yet', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ status: 'found', message: 'Thanks!' }) }));
  render(<ReportBug repList={null} />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  fireEvent.change(screen.getByLabelText(/what went wrong/i), { target: { value: 'Page is blank' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(sentBody.context.search).toBeNull();
});

test('shows the backend error message on a validation/rate-limit failure', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, status: 429, json: async () => ({ error: "You've submitted a lot of reports today — try again tomorrow." }) })
  );
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  fireEvent.change(screen.getByLabelText(/what went wrong/i), { target: { value: 'Something broke' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(screen.getByText(/submitted a lot of reports today/i)).toBeInTheDocument());
});

test('shows a network-failure message when the request itself throws', async () => {
  global.fetch = jest.fn(() => Promise.reject(new Error('network down')));
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  fireEvent.change(screen.getByLabelText(/what went wrong/i), { target: { value: 'Something broke' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());
});

test('reopening after a submission starts from a blank form', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ status: 'found', message: 'Thanks!' }) }));
  render(<ReportBug />);
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  fireEvent.change(screen.getByLabelText(/what went wrong/i), { target: { value: 'Something broke' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));
  await waitFor(() => expect(screen.getByText(/^thanks!$/i)).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  fireEvent.click(screen.getByRole('button', { name: /report a bug/i }));
  expect(screen.getByLabelText(/what went wrong/i)).toHaveValue('');
});
