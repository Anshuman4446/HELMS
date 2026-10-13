(function(){
  const suffixes=['api-base','api','service-api','service-auth','service-token','rider-id','token','hospital-api','hospital-token'];
  for(const store of [window.localStorage,window.sessionStorage]){
    for(const suffix of suffixes){
      const oldKey='sentry'+'helm-'+suffix, newKey='helms-'+suffix;
      const oldValue=store.getItem(oldKey);
      if(oldValue!==null){if(store.getItem(newKey)===null)store.setItem(newKey,oldValue);store.removeItem(oldKey);}
    }
  }
})();