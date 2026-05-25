-- 222km フィーバー: SU本社海老名起点で全 milestone 距離を再計算
-- 1. 削除: 海老名より東京寄り (横浜・港北PA・海老名SA)
DELETE FROM walk_milestones WHERE id IN (2, 9, 10);

-- 2. 富士川楽座を富士川SA併設として name 更新
UPDATE walk_milestones SET name='富士川楽座 / 富士川SA',
  description='東名高速 富士川SA併設・富士山と富士川を一望する大型休憩施設'
WHERE id=5;

-- 3. 各 milestone の km_from_tokyo を海老名起点 (=0) で再算出
UPDATE walk_milestones SET km_from_tokyo=0   WHERE id=1;   -- SU本社 (海老名)
UPDATE walk_milestones SET km_from_tokyo=14  WHERE id=11;  -- 中井PA
UPDATE walk_milestones SET km_from_tokyo=35  WHERE id=12;  -- 鮎沢PA
UPDATE walk_milestones SET km_from_tokyo=50  WHERE id=3;   -- 小田原
UPDATE walk_milestones SET km_from_tokyo=57  WHERE id=14;  -- 駒門PA
UPDATE walk_milestones SET km_from_tokyo=60  WHERE id=13;  -- 足柄SA
UPDATE walk_milestones SET km_from_tokyo=75  WHERE id=4;   -- 道の駅 ふじおやま
UPDATE walk_milestones SET km_from_tokyo=87  WHERE id=15;  -- 駿河湾沼津SA
UPDATE walk_milestones SET km_from_tokyo=107 WHERE id=5;   -- 富士川楽座 / 富士川SA
UPDATE walk_milestones SET km_from_tokyo=117 WHERE id=16;  -- 由比PA
UPDATE walk_milestones SET km_from_tokyo=122 WHERE id=17;  -- 清水PA
UPDATE walk_milestones SET km_from_tokyo=130 WHERE id=18;  -- 日本平PA
UPDATE walk_milestones SET km_from_tokyo=140 WHERE id=6;   -- 道の駅 宇津ノ谷峠
UPDATE walk_milestones SET km_from_tokyo=162 WHERE id=19;  -- 牧之原SA
UPDATE walk_milestones SET km_from_tokyo=174 WHERE id=20;  -- 小笠PA
UPDATE walk_milestones SET km_from_tokyo=183 WHERE id=7;   -- 道の駅 掛川
UPDATE walk_milestones SET km_from_tokyo=216 WHERE id=22;  -- 三方原PA
UPDATE walk_milestones SET km_from_tokyo=221 WHERE id=21;  -- 浜名湖SA
UPDATE walk_milestones SET km_from_tokyo=222 WHERE id=8;   -- SZE本社 (磐田)

-- 4. イベント全長を 222 に更新
UPDATE walk_events SET total_route_km=222 WHERE id=1;

-- 確認
SELECT id, name, km_from_tokyo FROM walk_milestones ORDER BY km_from_tokyo;
