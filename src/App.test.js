import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the search page', () => {
  render(<App />);
  expect(screen.getByText(/who reps me/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/address or zip code/i)).toBeInTheDocument();
});
