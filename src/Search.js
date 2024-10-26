import React, { useState } from 'react';
import axios from 'axios';

let apiKey;
let repList ={};

const getRepList = async (apiKey, location) => {
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
    return (repList);
  }
};

function Search(apiKey) {
  // const [location, setLocation] = useState('');
  let location = {};
  
  const handleChange = (event) => {
    // setLocation(event.target.value);
    location = event.target.value;
  };
  return (<>
    <div>
      <input type="text" className="search" value={location} onChange={handleChange} placeholder="Enter Location" />
      <button onClick={getRepList(apiKey, location)}>Search</button>
    </div>
  </>);
}
export default Search;
