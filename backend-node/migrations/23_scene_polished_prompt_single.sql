-- 场景单图提示词独立保存，避免复用四视图提示词。
ALTER TABLE scenes ADD COLUMN polished_prompt_single TEXT;
