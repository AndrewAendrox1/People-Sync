import {Link} from 'react-router-dom';

export function Brand(){
  return <Link className="brand supplied-brand" to="/" aria-label="People Sync home">
    <img src="/images/people-sync-logo.png" width="1254" height="1254" alt="People Sync" decoding="async"/>
  </Link>;
}
