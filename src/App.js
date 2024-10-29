import React, { useState } from 'react';
import axios from 'axios';

// import logo from './logo.svg';
import './App.css';

const apiKey = "16d983f13d34f95039958108";

function App() {
  const [repList, setRepList] = useState(null);

  return (
    <div className="App">
      <main>
        <h1 className='hero-title'>Who Reps Me?</h1>
        <h2 className='hero-subtitle'>An application to find your representatives</h2>
        <SearchBar apiKey={apiKey} setRepList={setRepList} />
        <Results repList={repList} />
      </main>
    </div>
  );
}
export default App;

function SearchBar({ apiKey, setRepList }) {
  const [location, setLocation] = useState('');

  const handleChange = (event) => {
    setLocation(event.target.value);
  };

  const executeSearch = async () => {
    getRepList(apiKey, location)
      .then(data => setRepList(data));
  }

  return (
    <div className='search-bar'>
      <input
        type="text"
        className="search"
        value={location}
        onChange={handleChange}
        placeholder="Enter Location"
      />
      <button
        className='button-cta'
        onClick={executeSearch}
      >
        <span className="text">Search</span>
      </button>
    </div>
  );
}

async function getRepList(apiKey, location) {
  try {
    // add in package.json -> "proxy": "https://api.5calls.org",
    const response = await axios.get(`/v1/representatives?location=${location}`, {
      headers: {
        'X-5Calls-Token': apiKey,
        'Content-Type': 'application/json',
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching data:', error);
  }
}

function Results({ repList }) {
  return (
    <section className="results">
      {/* <pre>{JSON.stringify(repList, null, 2)}</pre> */}
      {repList?.representatives?.map((rep) => (
        <section key={rep.id} className={`rep-card ${rep.area.toLowerCase().replace(/\ /g, "-")}`}>
          <img src={rep.photoURL} alt={rep.name} />
          <div>
            <h2>{rep.name}</h2>
            <ul>
              <li>{rep.area}</li>
              <li><a href={`tel:${rep.phone}`}>{rep.phone}</a></li>
              <li><a href={`${rep.url}`}>{rep.url}</a></li>
            </ul>
          </div>
         
        </section>
      ))}
    </section>
  );
}

