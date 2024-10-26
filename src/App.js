import React, { useState } from 'react';
import axios from 'axios';

import logo from './logo.svg';
import './App.css';
// import Search from './Search.js';
// import Results from './Results.js';

const apiKey = "16d983f13d34f95039958108";
let repList = [];
// const getRepList = async (apiKey, location) => {
async function getRepList(apiKey, location){
  // const [isLoading, setIsLoading] = useState(false);
  try{
    // setIsLoading(true);
    const response = await axios.get(`/v1/representatives?location=${location}`, {
      headers: {
        'X-5Calls-Token': apiKey,
        'Content-Type': 'application/json',
      }
    });
    repList = response.data;
  } catch(error) {
    console.error('Error fetching data:', error);
  } finally {
    // setIsLoading(false);
    return repList;
  }
};

function SearchBar({apiKey}) {
  // const [location, setLocation] = useState('');
  let location;

  const handleChange = (event) => {
    // setLocation(event.target.value);
    location = event.target.value;
  };
  return (<>
    <div className='search-bar'>
      <input type="text" className="search" value={location} 
        onChange={handleChange} 
      placeholder="Enter Location" />
      <button className='button-cta'
        onClick={()=>getRepList(apiKey, location)}
      ><span className="text">Search</span></button>
    </div>
  </>);
}

function Results({ repList }) {
  const cardList = [];
  repList.forEach((rep) => {
    cardList.push(
      repCard(rep)
    );
  });
  return cardList;
}

function repCard(rep) {
  return (
    <section key={rep.id} className='rep-card' >
      <img src={rep.photoURL} alt={rep.name} />
      <ul>
        <li>{rep.name}</li>
        <li>{rep.phone}</li>
      </ul>
      <pre>{JSON.stringify(rep, null, 2)}</pre>
    </section>
  );
}

// const repList = [
//   {
//     "id": "C001131",
//     "name": "Gregorio Casar",
//     "phone": "202-225-5645",
//     "url": "https://casar.house.gov",
//     "photoURL": "https://images.5calls.org/house/256/C001131.jpg",
//     "party": "Democrat",
//     "state": "TX",
//     "district": "35",
//     "reason": "This is your representative in the House.",
//     "area": "US House",
//     "field_offices": [
//       {
//         "phone": "210-580-7000",
//         "city": "San Antonio"
//       },
//       {
//         "phone": "512-691-1200",
//         "city": "Austin"
//       }
//     ]
//   },
//   {
//     "id": "b55d57f4-bd06-4487-8860-0b6eeb9a1dea",
//     "name": "Erin Zwiener",
//     "phone": "512-463-0647",
//     "url": "",
//     "photoURL": "https://house.texas.gov/members/photos/3710.jpg?v=88.25",
//     "party": "Democrat",
//     "state": "TX",
//     "district": "45",
//     "reason": "This is one of your State Legislators.",
//     "area": "StateLower",
//     "field_offices": []
//   },
//   {
//     "id": "c7aad3b7-ca16-4989-bf68-87ed72498a6b",
//     "name": "Judith Zaffirini",
//     "phone": "956-722-2293",
//     "url": "",
//     "photoURL": "https://senate.texas.gov/members/d21/img/Zaffirini_2017.jpg",
//     "party": "Democrat",
//     "state": "TX",
//     "district": "21",
//     "reason": "This is one of your State Legislators.",
//     "area": "StateUpper",
//     "field_offices": []
//   }
// ];

function App() {
  return (<>
    <div className="App">
      <main>
        <h1 className='hero-text'>Who Reps Me?</h1>
        <SearchBar apiKey={apiKey} />
        <Results repList={repList} />
      </main>
    </div>
  </>);
}

export default App;
