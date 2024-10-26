function RepCard (rep){
    return(
        <section >
            <img src={rep.url}/>
            <ul>
                <li>{rep.name}</li>
            </ul>
        </section>
    );
}

function Results(){
    return(
        <RepCard rep={null}/>
    );
}

export default Results();