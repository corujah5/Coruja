(()=>{
  const $=selector=>document.querySelector(selector);
  let adminUsers=[],accountsLoaded=false,accountsLoading=false;
  const createButton=$('#adminMobileCreateUser');
  const formError=$('#adminMobileCreateUserError');
  const credentialResult=$('#adminMobileCreateUserResult');
  const accountsError=$('#adminMobileAccountsError');
  const accountsLoadingMessage=$('#adminMobileAccountsLoading');
  const accountsBody=$('#adminMobileAccountsBody');
  const accountsList=$('#adminMobileAccountsList');
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
      if(accountsLoaded)await loadAccounts();
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

  async function adminRequest(url,options={}){
    const headers=new Headers(options.headers||{});
    const response=await fetch(url,{...options,headers,credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||'Não foi possível concluir a operação.');
    return data;
  }

  function accountButton(label,className,onClick){
    const button=document.createElement('button');
    button.type='button';
    button.className='adminMobileButton secondary '+(className||'');
    button.textContent=label;
    button.addEventListener('click',onClick);
    return button;
  }

  function renderAccounts(){
    const query=$('#adminMobileAccountsSearch').value.trim().toLocaleLowerCase();
    const visible=adminUsers.filter(user=>`${user.name||''} ${user.username||''}`.toLocaleLowerCase().includes(query));
    accountsList.replaceChildren();
    if(!visible.length){
      const empty=document.createElement('p');
      empty.className='adminMobileAccountsEmpty';
      empty.textContent=query?'Nenhuma conta corresponde à pesquisa.':'Nenhuma conta cadastrada.';
      accountsList.append(empty);
      return;
    }
    visible.forEach(user=>{
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
    setAccountActionsDisabled(!resetResult.hidden);
  }

  function showAccountsError(message){
    accountsError.textContent=message;
    accountsError.hidden=false;
  }

  async function loadAccounts(){
    if(accountsLoading)return;
    accountsLoading=true;
    accountsError.hidden=true;
    accountsLoadingMessage.hidden=false;
    accountsBody.hidden=true;
    try{
      const data=await adminRequest('/api/admin/users');
      adminUsers=Array.isArray(data.users)?data.users:[];
      accountsLoaded=true;
      accountsBody.hidden=false;
      renderAccounts();
    }catch(error){
      showAccountsError(error.message);
    }finally{
      accountsLoadingMessage.hidden=true;
      accountsLoading=false;
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
  $('#adminMobileAccountsSearch').addEventListener('input',renderAccounts);
  $('#adminMobileCopyTemporaryPassword').addEventListener('click',copyTemporaryPassword);
  $('#adminMobileCloseTemporaryPassword').addEventListener('click',closeTemporaryPassword);
  $('#adminMobileCancelReset').addEventListener('click',()=>{pendingResetUser=null;resetConfirmDialog.close();});
  confirmResetButton.addEventListener('click',confirmResetAccountPassword);
  resetConfirmDialog.addEventListener('cancel',()=>{pendingResetUser=null;});
  window.addEventListener('hashchange',()=>{if(location.hash==='#admin-mobile')loadAccounts();});
  if(location.hash==='#admin-mobile')loadAccounts();
})();
