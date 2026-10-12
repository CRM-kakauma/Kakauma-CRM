-- =====================================================================
-- KAKAUMA CRM — e-mail in the person's own HTML
--   content.format = 'html' with content.html (variables {{...}} allowed);
--   'blocks' (default) keeps the block editor. Same rules otherwise.
-- =====================================================================

create or replace function crm.template_errors(p_channel text, c jsonb) returns text[]
language plpgsql immutable as $$
declare
  e text[] := '{}';
  b jsonb;
  url_ok text := '^(https?://|\{\{\s*\w+\s*\}\})';
  n_url int; n_phone int;
begin
  if c is null or jsonb_typeof(c) <> 'object' then return array['Conteúdo inválido']; end if;
  if p_channel = 'email' then
    if coalesce(btrim(c ->> 'subject'), '') = '' then e := array_append(e, 'Assunto é obrigatório'); end if;
    if length(c ->> 'subject') > 150 then e := array_append(e, 'Assunto com mais de 150 caracteres'); end if;
    if length(c ->> 'preheader') > 200 then e := array_append(e, 'Pré-cabeçalho com mais de 200 caracteres'); end if;
    if coalesce(c ->> 'format', 'blocks') not in ('blocks','html') then
      e := array_append(e, 'Formato do e-mail deve ser blocos ou HTML');
    elsif c ->> 'format' = 'html' then
      if coalesce(btrim(c ->> 'html'), '') = '' then
        e := array_append(e, 'Cole ou escreva o HTML do e-mail');
      elsif length(c ->> 'html') > 100000 then
        e := array_append(e, 'HTML com mais de 100 mil caracteres (o Gmail corta e-mails grandes)');
      elsif c ->> 'html' ~* '<script' then
        e := array_append(e, 'O HTML não pode ter <script> (e-mails não executam scripts)');
      elsif c ->> 'html' ~* '<(form|iframe|object|embed)\M' then
        e := array_append(e, 'O HTML não pode ter formulários, iframes ou objetos incorporados');
      end if;
    elsif jsonb_typeof(c -> 'blocks') is distinct from 'array' or jsonb_array_length(c -> 'blocks') = 0 then
      e := array_append(e, 'Adicione pelo menos um bloco ao e-mail');
    elsif jsonb_array_length(c -> 'blocks') > 40 then
      e := array_append(e, 'Máximo de 40 blocos');
    else
      for b in select * from jsonb_array_elements(c -> 'blocks') loop
        if coalesce(b ->> 'type', '') not in ('heading','text','button','image','divider','spacer') then
          e := array_append(e, format('Bloco desconhecido: %s', b ->> 'type'));
        elsif b ->> 'type' in ('heading','text','button') and coalesce(btrim(b ->> 'text'), '') = '' then
          e := array_append(e, format('Bloco "%s" sem texto', b ->> 'type'));
        elsif b ->> 'type' in ('button','image') and coalesce(b ->> 'url', '') !~ url_ok then
          e := array_append(e, format('Bloco "%s": o link deve começar com https://', b ->> 'type'));
        end if;
      end loop;
    end if;
  elsif p_channel = 'sms' then
    if coalesce(btrim(c ->> 'text'), '') = '' then e := array_append(e, 'Texto do SMS é obrigatório'); end if;
    if length(c ->> 'text') > 670 then e := array_append(e, 'SMS com mais de 670 caracteres (muitas partes)'); end if;
  elsif p_channel = 'whatsapp' then
    if coalesce(btrim(c ->> 'body'), '') = '' then e := array_append(e, 'Corpo da mensagem é obrigatório'); end if;
    if length(c ->> 'body') > 1024 then e := array_append(e, 'Corpo com mais de 1024 caracteres'); end if;
    if coalesce(c #>> '{header,type}', 'none') not in ('none','text','image') then
      e := array_append(e, 'Cabeçalho inválido');
    elsif c #>> '{header,type}' = 'text' and (coalesce(btrim(c #>> '{header,text}'), '') = '' or length(c #>> '{header,text}') > 60) then
      e := array_append(e, 'Cabeçalho de texto: 1 a 60 caracteres');
    elsif c #>> '{header,type}' = 'image' and coalesce(c #>> '{header,url}', '') !~ url_ok then
      e := array_append(e, 'Cabeçalho de imagem: o link deve começar com https://');
    end if;
    if length(c ->> 'footer') > 60 then e := array_append(e, 'Rodapé com mais de 60 caracteres'); end if;
    if coalesce(c ->> 'category', 'marketing') not in ('marketing','utility') then
      e := array_append(e, 'Categoria deve ser marketing ou utilidade');
    end if;
    if jsonb_typeof(c -> 'buttons') = 'array' then
      if jsonb_array_length(c -> 'buttons') > 3 then e := array_append(e, 'Máximo de 3 botões'); end if;
      select count(*) filter (where x ->> 'type' = 'url'), count(*) filter (where x ->> 'type' = 'phone')
        into n_url, n_phone from jsonb_array_elements(c -> 'buttons') x;
      if n_url > 2 then e := array_append(e, 'Máximo de 2 botões de link'); end if;
      if n_phone > 1 then e := array_append(e, 'Máximo de 1 botão de ligação'); end if;
      for b in select * from jsonb_array_elements(c -> 'buttons') loop
        if coalesce(b ->> 'type', '') not in ('quick_reply','url','phone') then
          e := array_append(e, 'Tipo de botão inválido');
        elsif coalesce(btrim(b ->> 'text'), '') = '' or length(b ->> 'text') > 25 then
          e := array_append(e, 'Texto do botão: 1 a 25 caracteres');
        elsif b ->> 'type' = 'url' and coalesce(b ->> 'url', '') !~ url_ok then
          e := array_append(e, 'Botão de link: deve começar com https://');
        elsif b ->> 'type' = 'phone' and coalesce(b ->> 'phone', '') !~ '^\+?[0-9 ()-]{10,20}$' then
          e := array_append(e, 'Botão de ligação: telefone inválido');
        end if;
      end loop;
    end if;
  elsif p_channel = 'rcs' then
    if coalesce(c ->> 'kind', '') not in ('text','card','carousel') then
      e := array_append(e, 'Tipo de RCS deve ser texto, cartão ou carrossel');
    elsif c ->> 'kind' = 'text' and (coalesce(btrim(c ->> 'text'), '') = '' or length(c ->> 'text') > 2000) then
      e := array_append(e, 'Texto: 1 a 2000 caracteres');
    elsif c ->> 'kind' in ('card','carousel') then
      if jsonb_typeof(c -> 'cards') is distinct from 'array' or jsonb_array_length(c -> 'cards') = 0 then
        e := array_append(e, 'Adicione um cartão');
      elsif c ->> 'kind' = 'carousel' and jsonb_array_length(c -> 'cards') not between 2 and 10 then
        e := array_append(e, 'Carrossel: de 2 a 10 cartões');
      else
        for b in select * from jsonb_array_elements(c -> 'cards') loop
          if coalesce(btrim(b ->> 'title'), '') = '' or length(b ->> 'title') > 200 then
            e := array_append(e, 'Título do cartão: 1 a 200 caracteres');
          end if;
          if length(b ->> 'description') > 2000 then e := array_append(e, 'Descrição do cartão: até 2000 caracteres'); end if;
          if coalesce(b ->> 'media_url', '') <> '' and b ->> 'media_url' !~ url_ok then
            e := array_append(e, 'Imagem do cartão: o link deve começar com https://');
          end if;
        end loop;
      end if;
    end if;
    if jsonb_typeof(c -> 'suggestions') = 'array' then
      if jsonb_array_length(c -> 'suggestions') > 4 then e := array_append(e, 'Máximo de 4 sugestões'); end if;
      for b in select * from jsonb_array_elements(c -> 'suggestions') loop
        if coalesce(b ->> 'type', '') not in ('reply','url','dial') then
          e := array_append(e, 'Tipo de sugestão inválido');
        elsif coalesce(btrim(b ->> 'text'), '') = '' or length(b ->> 'text') > 25 then
          e := array_append(e, 'Texto da sugestão: 1 a 25 caracteres');
        elsif b ->> 'type' = 'url' and coalesce(b ->> 'url', '') !~ url_ok then
          e := array_append(e, 'Sugestão de link: deve começar com https://');
        elsif b ->> 'type' = 'dial' and coalesce(b ->> 'phone', '') !~ '^\+?[0-9 ()-]{10,20}$' then
          e := array_append(e, 'Sugestão de ligação: telefone inválido');
        end if;
      end loop;
    end if;
    if coalesce(btrim(c ->> 'fallback_sms'), '') = '' then
      e := array_append(e, 'Texto de SMS alternativo é obrigatório (para aparelhos sem RCS)');
    end if;
  else
    e := array_append(e, 'Canal inválido');
  end if;
  return e;
end;
$$;
