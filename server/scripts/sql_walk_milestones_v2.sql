-- 既存 8 milestone の image_url + description を更新
UPDATE walk_milestones SET image_url='/assets/walk/milestone_tokyo.png',       description='江戸の出発点・スタンダード運輸 出発' WHERE id=1;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_yokohama.png',    description='みなとみらい・港町横浜の活気' WHERE id=2;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_odawara.png',     description='相模湾を望む小田原城下町' WHERE id=3;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_fujioyama.png',   description='富士山南麓の道の駅・農産物直売所' WHERE id=4;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_fujikawa.png',    description='富士川と富士山を一望する大型道の駅' WHERE id=5;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_utsunoya.png',    description='旧東海道の難所・苔むす峠' WHERE id=6;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_kakegawa.png',    description='茶どころ掛川・木造再建の天守' WHERE id=7;
UPDATE walk_milestones SET image_url='/assets/walk/milestone_iwata.png',       description='ジュビロ磐田の街・スズエ電機本社 ゴール' WHERE id=8;

-- 新規 SA/PA 14個 を追加 (event_id=1)
INSERT INTO walk_milestones (event_id, name, km_from_tokyo, image_url, description, sort_order) VALUES
  (1, '港北PA',           8,   '/assets/walk/milestone_kohoku.png',      '都市型パーキング・横浜港北', 1),
  (1, '海老名SA',         15,  '/assets/walk/milestone_ebina.png',       '関東最大級SA・名物メロンパン', 2),
  (1, '中井PA',           35,  '/assets/walk/milestone_nakai.png',       '丘陵から富士山遠望', 3),
  (1, '鮎沢PA',           60,  '/assets/walk/milestone_ayuzawa.png',     '山あいの小休憩所・杉林に囲まれて', 4),
  (1, '足柄SA',           95,  '/assets/walk/milestone_ashigara.png',    '富士山絶景・温泉あり', 5),
  (1, '駒門PA',           115, '/assets/walk/milestone_komakado.png',    '御殿場・ススキ高原', 6),
  (1, '駿河湾沼津SA',     125, '/assets/walk/milestone_suruga.png',      '駿河湾オーシャンビュー', 7),
  (1, '由比PA',           150, '/assets/walk/milestone_yui.png',         '薩埵峠・桜エビと富士山絶景', 8),
  (1, '清水PA',           158, '/assets/walk/milestone_shimizu.png',     '清水港・ちびまる子ちゃんの故郷', 9),
  (1, '日本平PA',         165, '/assets/walk/milestone_nihondaira.png',  '茶畑と富士山・駿河湾の高台', 10),
  (1, '牧之原SA',         190, '/assets/walk/milestone_makinohara.png',  '一面の茶畑・新茶ライン', 11),
  (1, '小笠PA',           200, '/assets/walk/milestone_ogasa.png',       '掛川の里山・夕暮れ田園', 12),
  (1, '浜名湖SA',         218, '/assets/walk/milestone_hamanako.png',    '浜名湖一望・うなぎの町', 13),
  (1, '三方原PA',         225, '/assets/walk/milestone_mikatahara.png',  '武田信玄合戦地・松林の台地', 14);

SELECT COUNT(*) AS total_milestones FROM walk_milestones;
