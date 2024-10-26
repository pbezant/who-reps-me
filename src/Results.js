function RepCard (rep){
    return(
        <section >
            <img src={rep.url}/>
            <ul>
                <li>rep.name</li>
            </ul>
        </section>
    );
}

function Results(repList){
    return(<>
        <RepCard rep={null}/>
        {repList && (
            <>
              <pre>{JSON.stringify(repList, null, 2)}</pre>
            </>
          )}
    </>);
}

export default Results();