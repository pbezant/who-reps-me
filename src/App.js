import logo from './logo.svg';
import './App.css';
import {Search, repList} from './Search.js';
// import Results from './Results.js';

const apiKey = "16d983f13d34f95039958108";
// let repList;

function App() {
  return (
    <div className="App">
      <main>
        <h1 className='hero-text'>Who Reps Me?</h1>
        <Search apiKey={apiKey}/>
        <Results />
      </main>
    </div>
  );
}

export default App;
