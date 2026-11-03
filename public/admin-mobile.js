(()=>{
  const $=selector=>document.querySelector(selector);
 let adminUsers=[],accountsLoaded=false,accountsLoading=false,adminKey='',accountsPage=1,accountsPageSize=10;
 const accessCard=$('#adminMobileAccessCard');
 const accessForm=$('#adminMobileAccessForm');
 const accessKey=$('#adminMobileAccessKey');
 const accessError=$('#adminMobileAccessError');
 const connectButton=$('#adminMobileConnect');
 const disconnectButton=$('#adminMobileDisconnect');
 const protectedSections=[...document.querySelectorAll('#admin-mobile [data-admin-protected]')];
  const createButton=$('#adminMobileCreateUser');
  const formError=$('#adminMobileCreateUserError');
  const credentialResult=$('#adminMobileCreateUserResult');
  const accountsError=$('#adminMobileAccountsError');
  const accountsLoadingMessage=$('#adminMobileAccountsLoading');
  const accountsBody=$('#adminMobileAccountsBody');
  const accountsList=$('#adminMobileAccountsList');
  const accountsPageSizeSelect=$('#adminMobileAccountsPageSize');
  const accountsPager=$('#adminMobileAccountsPager');
  const accountsRange=$('#adminMobileAccountsRange');
  const resetResult=$('#adminMobileResetResult');
  const temporaryPassword=$('#adminMobileTemporaryPassword');
  const resetConfirmDialog=$('#adminMobileResetConfirmDialog');
  const resetConfirmMessage=$('#adminMobileResetConfirmMessage');
  const confirmResetButton=$('#adminMobileConfirmReset');
  let pendingResetUser=null;

  function randomCredentialChars(alphabet,length){
    const values=new Uint8Array(length);
    crypto.getRandomValues(values);
    return Array.from(values,value=>alphabet[value%alphabet.length]).join('');
  }

  function generateCredentials(){
    const name=$('#adminMobileCreateName').value.trim();
    const base=(name||'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20)||'cliente';
    $('#adminMobileCreateUsername').value=base+randomCredentialChars('23456789',4);
    $('#adminMobileCreatePassword').value=randomCredentialChars('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_',16);
    formError.hidden=true;
    credentialResult.hidden=true;
  }

  async function createAccount(){
    const username=$('#adminMobileCreateUsername').value.trim();
    const password=$('#adminMobileCreatePassword').value;
    const name=$('#adminMobileCreateName').value.trim();
    formError.hidden=true;
    credentialResult.hidden=true;
    createButton.disabled=true;
    createButton.textContent='Criando…';
    try{
      const data=await adminRequest('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,username,password})});
      $('#adminMobileCreatedUsername').textContent=data.username;
      $('#adminMobileCreatedPassword').textContent=data.password;
      credentialResult.hidden=false;
      $('#adminMobileCreateName').value='';
      $('#adminMobileCreateUsername').value='';
      $('#adminMobileCreatePassword').value='';
      window.toast?.('Conta criada. Copie as credenciais agora.');
      if(accountsLoaded)await loadAccounts({preserveLayout:true,preservePage:true});
    }catch(error){
      formError.textContent=error.message||'Não foi possível criar a conta.';
      formError.hidden=false;
    }finally{
      createButton.disabled=false;
      createButton.textContent='Criar conta';
    }
  }

  async function copyCredentials(){
    const username=$('#adminMobileCreatedUsername').textContent;
    const password=$('#adminMobileCreatedPassword').textContent;
    if(!username||!password)return;
    try{
      await navigator.clipboard.writeText('Usuário: '+username+'\nSenha: '+password);
      window.toast?.('Credenciais copiadas!');
    }catch{
      formError.textContent='Não foi possível copiar automaticamente.';
      formError.hidden=false;
    }
  }

 function setPanelAccess(allowed){
 accessCard.hidden=allowed;
 protectedSections.forEach(section=>{section.hidden=!allowed;});
 disconnectButton.hidden=!allowed;
 }

 async function adminRequest(url,options={},key=adminKey){
 if(!key)throw new Error('Informe a chave administrativa para acessar o painel.');
    const headers=new Headers(options.headers||{});
 headers.set('x-admin-key',key);
    const response=await fetch(url,{...options,headers,credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
 if(response.status===401&&key===adminKey&&adminKey){adminKey='';accountsLoaded=false;setPanelAccess(false);}
    if(!response.ok)throw new Error(data.error||'Não foi possível concluir a operação.');
    return data;
  }

 async function connectAdmin(event){
 event.preventDefault();
 const candidate=accessKey.value;
 accessKey.value='';
 accessError.hidden=true;
 connectButton.disabled=true;
 connectButton.textContent='Validando…';
 try{
 await adminRequest('/api/admin/session',{},candidate);
 adminKey=candidate;
 setPanelAccess(true);
 accountsLoaded=false;
 await loadAccounts();
 }catch(error){
 accessError.textContent=error.message||'Não foi possível autorizar o painel.';
 accessError.hidden=false;
 }finally{
 connectButton.disabled=false;
 connectButton.textContent='Acessar painel';
 }
 }

 function disconnectAdmin(){
 adminKey='';
 accountsLoaded=false;
 adminUsers=[];
 accountsList.replaceChildren();
 clearTemporaryPassword();
 credentialResult.hidden=true;
 setPanelAccess(false);
 accessKey.focus();
 }

  function accountButton(label,className,onClick){
    const button=document.createElement('button');
    button.type='button';
    button.className='adminMobileButton secondary '+(className||'');
    button.textContent=label;
    button.addEventListener('click',onClick);
    return button;
  }

  function getAccountPage(users,query,requestedPage,pageSize){
    const filtered=users.filter(user=>`${user.name||''} ${user.username||''}`.toLocaleLowerCase().includes(query));
    const total=filtered.length;
    const totalPages=Math.max(1,Math.ceil(total/pageSize));
    const page=Math.min(Math.max(1,requestedPage),totalPages);
    const startIndex=total?(page-1)*pageSize:0;
    const endIndex=Math.min(startIndex+pageSize,total);
    return {items:filtered.slice(startIndex,endIndex),total,totalPages,page,startIndex,endIndex};
  }

  function renderAccountPagination(pageInfo){
    const {total,totalPages,page,startIndex,endIndex}=pageInfo;
    accountsRange.textContent=`Mostrando de ${total?startIndex+1:0} até ${endIndex} de ${total} registros`;
    accountsPager.replaceChildren();
    const addButton=(label,targetPage,{disabled=false,current=false}={})=>{
      const button=document.createElement('button');
      button.type='button';
      button.className='adminMobileAccountPageButton';
      button.textContent=label;
      button.dataset.page=String(targetPage);
      button.disabled=disabled;
      button.setAttribute('aria-label',label==='Anterior'?'Página anterior':label==='Seguinte'?'Próxima página':`Página ${label}`);
      if(current)button.setAttribute('aria-current','page');
      accountsPager.append(button);
    };
    addButton('Anterior',page-1,{disabled:page<=1});
    let pages;
    if(totalPages<=7)pages=Array.from({length:totalPages},(_,index)=>index+1);
    else pages=[...new Set([1,totalPages,...Array.from({length:3},(_,index)=>page+index-1).filter(value=>value>1&&value<totalPages)])].sort((a,b)=>a-b);
    let previousPage=0;
    pages.forEach(value=>{
      if(previousPage&&value-previousPage>1){
        const ellipsis=document.createElement('span');
        ellipsis.className='adminMobileAccountPageEllipsis';
        ellipsis.textContent='…';
        ellipsis.setAttribute('aria-hidden','true');
        accountsPager.append(ellipsis);
      }
      addButton(String(value),value,{disabled:value===page,current:value===page});
      previousPage=value;
    });
    addButton('Seguinte',page+1,{disabled:page>=totalPages});
  }

  function renderAccounts(){
    const query=$('#adminMobileAccountsSearch').value.trim().toLocaleLowerCase();
    const pageInfo=getAccountPage(adminUsers,query,accountsPage,accountsPageSize);
    accountsPage=pageInfo.page;
    accountsList.replaceChildren();
    if(!pageInfo.total){
      const empty=document.createElement('p');
      empty.className='adminMobileAccountsEmpty';
      empty.textContent=query?'Nenhuma conta corresponde à pesquisa.':'Nenhuma conta cadastrada.';
      accountsList.append(empty);
    }else{
      pageInfo.items.forEach(user=>{
        const row=document.createElement('article');
        row.className='adminMobileAccountRow';
        const info=document.createElement('div');
        info.className='adminMobileAccountInfo';
        const name=document.createElement('strong');
        name.textContent=user.name||'Coruja';
        const username=document.createElement('span');
        username.textContent='@'+(user.username||'');
        info.append(name,username);
        if(user.blocked){
          const status=document.createElement('small');
          status.className='adminMobileAccountBlocked';
          status.textContent='Conta bloqueada';
          info.append(status);
        }
        const actions=document.createElement('div');
        actions.className='adminMobileAccountActions';
        actions.append(
          accountButton('Copiar usuário','',async()=>{
            try{await navigator.clipboard.writeText(user.username||'');window.toast?.('Nome de usuário copiado!');}
            catch{showAccountsError('Não foi possível copiar automaticamente.');}
          }),
          accountButton('Redefinir senha','reset',()=>openResetConfirmation(user)),
          accountButton('Excluir conta','danger',()=>deleteAccount(user))
        );
        row.append(info,actions);
        accountsList.append(row);
      });
    }
    renderAccountPagination(pageInfo);
    setAccountActionsDisabled(!resetResult.hidden);
  }

  function showAccountsError(message){
    accountsError.textContent=message;
    accountsError.hidden=false;
  }

  async function loadAccounts({preserveLayout=false,preservePage=false}={}){
    if(accountsLoading)return;
    const previousScrollY=preserveLayout?(window.scrollY||0):null;
    accountsLoading=true;
    accountsError.hidden=true;
    if(preserveLayout){
      accountsLoadingMessage.hidden=true;
    }else{
      accountsLoadingMessage.hidden=false;
      accountsBody.hidden=true;
    }
    try{
      const data=await adminRequest('/api/admin/users');
      adminUsers=Array.isArray(data.users)?data.users:[];
      accountsLoaded=true;
      if(!preservePage)accountsPage=1;
      accountsBody.hidden=false;
      renderAccounts();
    }catch(error){
      showAccountsError(error.message);
    }finally{
      if(!preserveLayout)accountsLoadingMessage.hidden=true;
      accountsLoading=false;
      if(preserveLayout)window.requestAnimationFrame(()=>window.scrollTo(0,previousScrollY));
    }
  }

  function openResetConfirmation(user){
    pendingResetUser=user;
    resetConfirmMessage.textContent=`A senha atual de ${user.name||user.username} (@${user.username}) será substituída.`;
    resetConfirmDialog.showModal();
    setTimeout(()=>confirmResetButton.focus(),0);
  }

  function setAccountActionsDisabled(disabled){
    document.querySelectorAll('#adminMobileAccountsList .adminMobileAccountActions .adminMobileButton').forEach(button=>{button.disabled=disabled;});
  }

  function clearTemporaryPassword(){
    resetResult.hidden=true;
    temporaryPassword.textContent='';
    setAccountActionsDisabled(false);
  }

  async function confirmResetAccountPassword(){
    const user=pendingResetUser;
    if(!user)return;
    confirmResetButton.disabled=true;
    $('#adminMobileCancelReset').disabled=true;
    try{
      const data=await adminRequest(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`,{method:'POST'});
      if(!data.temporaryPassword)throw new Error('A senha temporária não foi retornada pelo servidor.');
      resetConfirmDialog.close();
      pendingResetUser=null;
      temporaryPassword.textContent=data.temporaryPassword;
      resetResult.hidden=false;
      setAccountActionsDisabled(true);
      resetResult.scrollIntoView({behavior:'smooth',block:'nearest'});
      $('#adminMobileCopyTemporaryPassword').focus();
    }catch(error){
      resetConfirmDialog.close();
      pendingResetUser=null;
      showAccountsError(error.message);
    }finally{
      confirmResetButton.disabled=false;
      $('#adminMobileCancelReset').disabled=false;
    }
  }

  async function copyTemporaryPassword(){
    const value=temporaryPassword.textContent;
    if(!value)return;
    try{
      await navigator.clipboard.writeText(value);
      clearTemporaryPassword();
      window.toast?.('Senha temporária copiada. Ela foi removida da tela.');
    }catch{showAccountsError('Não foi possível copiar a senha temporária.');}
  }

  function closeTemporaryPassword(){clearTemporaryPassword();}

  async function deleteAccount(user){
    if(!window.confirm(`Excluir permanentemente a conta de ${user.name||user.username} (@${user.username})? Esta ação remove os dados da conta e encerra as sessões.`))return;
    accountsError.hidden=true;
    try{
      await adminRequest(`/api/admin/users/${encodeURIComponent(user.id)}`,{method:'DELETE'});
      adminUsers=adminUsers.filter(item=>item.id!==user.id);
      clearTemporaryPassword();
      renderAccounts();
      window.toast?.('Conta excluída.');
    }catch(error){showAccountsError(error.message);}
  }

  $('#adminMobileGenerateCredentials').addEventListener('click',generateCredentials);
  createButton.addEventListener('click',createAccount);
  $('#adminMobileCopyCredentials').addEventListener('click',copyCredentials);
  $('#adminMobileAccountsSearch').addEventListener('input',()=>{accountsPage=1;renderAccounts();});
  accountsPageSizeSelect.addEventListener('change',()=>{
    const requestedSize=Number(accountsPageSizeSelect.value);
    accountsPageSize=[10,25,50,100].includes(requestedSize)?requestedSize:10;
    accountsPage=1;
    renderAccounts();
  });
  accountsPager.addEventListener('click',event=>{
    const button=event.target.closest('button[data-page]');
    if(!button||button.disabled)return;
    const page=Number(button.dataset.page);
    if(!Number.isInteger(page)||page<1)return;
    accountsPage=page;
    renderAccounts();
  });
  $('#adminMobileCopyTemporaryPassword').addEventListener('click',copyTemporaryPassword);
  $('#adminMobileCloseTemporaryPassword').addEventListener('click',closeTemporaryPassword);
  $('#adminMobileCancelReset').addEventListener('click',()=>{pendingResetUser=null;resetConfirmDialog.close();});
  confirmResetButton.addEventListener('click',confirmResetAccountPassword);
  resetConfirmDialog.addEventListener('cancel',()=>{pendingResetUser=null;});
 accessForm.addEventListener('submit',connectAdmin);
 disconnectButton.addEventListener('click',disconnectAdmin);
 window.addEventListener('hashchange',()=>{
 if(location.hash==='#admin-mobile'){setPanelAccess(!!adminKey);if(adminKey)loadAccounts();}
 else if(adminKey)disconnectAdmin();
 });
 setPanelAccess(false);
})();
