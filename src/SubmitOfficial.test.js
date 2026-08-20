import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitOfficial from './SubmitOfficial';

afterEach(() => {
  delete global.fetch;
});

test('renders only the floating button until clicked', () => {
  render(<SubmitOfficial />);
  expect(screen.getByRole('button', { name: /suggest an official/i })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('opens the dialog on click, focused on the URL field', () => {
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText(/official's page url/i)).toHaveFocus();
});

test('Escape closes the dialog', () => {
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the submit button stays disabled with no URL entered', () => {
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
});

test('submits the URL/note to /api/submit-official and shows the success message', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: async () => ({ status: 'found', message: 'Thanks! Found Jane Doe (Mayor) for Elgin, TX.' }),
    })
  );
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  fireEvent.change(screen.getByLabelText(/official's page url/i), {
    target: { value: 'https://www.elgintx.com/149/City-Council' },
  });
  fireEvent.change(screen.getByLabelText(/anything else worth knowing/i), { target: { value: 'the mayor' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(screen.getByText(/thanks! found jane doe/i)).toBeInTheDocument());

  expect(global.fetch).toHaveBeenCalledWith('/api/submit-official', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ url: 'https://www.elgintx.com/149/City-Council', note: 'the mayor' }),
  }));
});

test('shows the backend error message on a validation failure', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "That doesn't look like a valid URL." }) })
  );
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  fireEvent.change(screen.getByLabelText(/official's page url/i), { target: { value: 'not-a-url' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(screen.getByText(/doesn't look like a valid url/i)).toBeInTheDocument());
});

test('shows a network-failure message when the request itself throws', async () => {
  global.fetch = jest.fn(() => Promise.reject(new Error('network down')));
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  fireEvent.change(screen.getByLabelText(/official's page url/i), { target: { value: 'https://example.gov/council' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));

  await waitFor(() => expect(screen.getByText(/couldn't reach the server/i)).toBeInTheDocument());
});

test('reopening after a submission starts from a blank form', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ status: 'not-found', message: 'No officials found.' }) })
  );
  render(<SubmitOfficial />);
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  fireEvent.change(screen.getByLabelText(/official's page url/i), { target: { value: 'https://example.gov/council' } });
  fireEvent.click(screen.getByRole('button', { name: /submit/i }));
  await waitFor(() => expect(screen.getByText(/no officials found/i)).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  fireEvent.click(screen.getByRole('button', { name: /suggest an official/i }));
  expect(screen.getByLabelText(/official's page url/i)).toHaveValue('');
  expect(screen.queryByText(/no officials found/i)).not.toBeInTheDocument();
});
