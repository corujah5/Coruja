(()=>{
  let adminKey='';
  async function send(url,options,key){
    const headers=new Headers(options.headers||{});
    headers.set('x-admin-key',key);
    const response=await fetch(url,{...options,headers,credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
    if(response.status===401&&key===adminKey)adminKey='';
    if(!response.ok)throw new Error(data.error||'Não foi possível concluir a operação.');
    return data;
  }
  window.CorujaClassicAdminAuth=Object.freeze({
    isAuthorized(){return Boolean(adminKey)},
    clear(){adminKey=''},
    async authorize(candidate){
      adminKey='';
      const key=String(candidate||'');
      if(!key)throw new Error('Informe a chave administrativa para acessar o painel.');
      const result=await send('/api/admin/session',{},key);
      adminKey=key;
      return result;
    },
    async request(url,options={}){
      if(!adminKey)throw new Error('Informe a chave administrativa para acessar o painel.');
      return send(url,options,adminKey);
    }
  });
})();
