insert into public.settings (key, value) values
  ('ai_config', '[{"id":"gemini","name":"Gemini 2.0 Flash","key":"GEMINI_API_KEY","enabled":true},{"id":"claude","name":"Claude Haiku 4.5","key":"ANTHROPIC_API_KEY","enabled":false},{"id":"deepseek","name":"DeepSeek Chat","key":"DEEPSEEK_API_KEY","enabled":true}]')
on conflict (key) do nothing;
