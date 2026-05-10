#!/usr/bin/env python3
"""
タカラ配車 OR-Tools VRP ソルバー (Phase A / MVP)

入力: stdin に JSON
出力: stdout に JSON
タイムリミット: 既定 20 秒

制約:
  1) 号車容量(才) を超えない
  2) 時間指定ウィンドウ厳守 (時間指定なしは 08:00-18:00)
  3) 2t車は 14:00 までに depot 帰着
  4) 庸車(virtual) を許容(高ペナルティ)
  5) 距離は住所前方一致段階(都道府県->市->区->番地) のスコア
"""
from __future__ import annotations
import sys
import json
import re
from typing import Any
from ortools.constraint_solver import pywrapcp, routing_enums_pb2


# ---- 住所マッチで距離スコア ----------------------------------------------
def addr_levels(addr: str) -> tuple[str, str, str, str]:
    """住所を (都道府県, 市, 区, 残り) に粗く分解"""
    s = (addr or "").strip()
    # 都道府県
    m = re.match(r"^(.+?[都道府県])", s)
    pref = m.group(1) if m else ""
    s2 = s[len(pref):].strip() if pref else s
    # 市/郡 - 神奈川県横浜市西区... の場合は市+区
    m = re.match(r"^(.+?[市郡])", s2)
    city = m.group(1) if m else ""
    s3 = s2[len(city):].strip() if city else s2
    # 区/町 (横浜市西区 みたいに既に区を消費してる場合もあるが緩く)
    m = re.match(r"^(.+?[区町村])", s3)
    ward = m.group(1) if m else ""
    rest = s3[len(ward):].strip() if ward else s3
    return pref, city, ward, rest


def addr_distance(a: str, b: str) -> int:
    """住所2つの「距離」(分換算近似)。同区=10分, 同市異区=25分, 同県異市=60分, 県違い=120分"""
    if a == b:
        return 8  # 同一現場(別ストップ・本数違い等)
    pa, ca, wa, _ra = addr_levels(a)
    pb, cb, wb, _rb = addr_levels(b)
    if pa != pb:
        return 120
    if ca != cb:
        return 60
    if wa != wb:
        return 25
    return 10  # 同区内


def parse_time_window(time_spec: str | None, default_start: int, default_end: int) -> tuple[int, int]:
    """time_spec を分単位ウィンドウに変換"""
    if not time_spec:
        return (default_start, default_end)
    s = str(time_spec).strip()
    # "AM" / "午前"
    if s in ("AM", "午前"):
        return (8 * 60, 12 * 60)
    if s in ("PM", "午後"):
        return (12 * 60, 17 * 60)
    # "11:00" 単一指定 → ±30分
    m = re.match(r"^(\d{1,2}):(\d{2})", s)
    if m:
        t = int(m.group(1)) * 60 + int(m.group(2))
        return (max(0, t - 30), min(24 * 60 - 1, t + 30))
    # "9:00-11:00"
    m = re.match(r"^(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})", s)
    if m:
        t1 = int(m.group(1)) * 60 + int(m.group(2))
        t2 = int(m.group(3)) * 60 + int(m.group(4))
        return (t1, t2)
    return (default_start, default_end)


def solve(payload: dict[str, Any]) -> dict[str, Any]:
    vehicles = payload.get("vehicles", [])  # [{id, capacity_sai, return_by_min, ...}, ...]
    stops = payload.get("stops", [])         # [{id, address, sai, time_spec, service_min}, ...]
    depot_addr = payload.get("depot_address", "神奈川県座間市")
    time_limit = int(payload.get("time_limit_sec", 20))

    if not stops:
        return {"success": True, "assignments": [], "unassigned": [], "stats": {"reason": "no stops"}}

    # ノード 0 = depot, 1..N = stops
    n_stops = len(stops)
    addresses = [depot_addr] + [s.get("address", "") for s in stops]

    # 距離行列
    dist = [[addr_distance(addresses[i], addresses[j]) for j in range(n_stops + 1)] for i in range(n_stops + 1)]

    # 時間行列 (距離分 + 各stopのservice_min を toノード側に加算)
    service = [0] + [int(s.get("service_min", 25)) for s in stops]
    time_mat = [[dist[i][j] + (service[j] if j != 0 else 0) for j in range(n_stops + 1)] for i in range(n_stops + 1)]

    # 容量
    demand = [0] + [max(0, int(round(s.get("sai", 0)))) for s in stops]
    veh_capacity = [int(v.get("capacity_sai", 240)) for v in vehicles]

    # 庸車を仮想車両として付加
    n_real = len(vehicles)
    n_charter = int(payload.get("charter_max", 5))
    charter_capacity = int(payload.get("charter_capacity", 600))  # 庸車4t想定
    for _ in range(n_charter):
        veh_capacity.append(charter_capacity)
    n_veh = len(veh_capacity)

    # 時間ウィンドウ (depot=0は終日, 各stopは指定窓)
    default_start = int(payload.get("day_start_min", 7 * 60))
    default_end = int(payload.get("day_end_min", 18 * 60))
    windows = [(default_start, default_end)]
    for s in stops:
        windows.append(parse_time_window(s.get("time_spec"), default_start, default_end))

    # 帰着制約 (車両ごと)
    veh_return_by = [int(v.get("return_by_min", default_end)) for v in vehicles]
    for _ in range(n_charter):
        veh_return_by.append(default_end)

    veh_start_by = [int(v.get("start_by_min", default_start)) for v in vehicles] + [default_start] * n_charter

    manager = pywrapcp.RoutingIndexManager(n_stops + 1, n_veh, 0)
    routing = pywrapcp.RoutingModel(manager)

    # 距離コールバック (移動コスト)
    def dist_cb(from_idx, to_idx):
        i = manager.IndexToNode(from_idx)
        j = manager.IndexToNode(to_idx)
        return dist[i][j]
    transit_cb_idx = routing.RegisterTransitCallback(dist_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_cb_idx)

    # 庸車にはペナルティを付加
    for v in range(n_real, n_veh):
        routing.SetFixedCostOfVehicle(10000, v)

    # 容量
    def demand_cb(from_idx):
        return demand[manager.IndexToNode(from_idx)]
    demand_cb_idx = routing.RegisterUnaryTransitCallback(demand_cb)
    routing.AddDimensionWithVehicleCapacity(demand_cb_idx, 0, veh_capacity, True, "Capacity")

    # 時間
    def time_cb(from_idx, to_idx):
        i = manager.IndexToNode(from_idx)
        j = manager.IndexToNode(to_idx)
        return time_mat[i][j]
    time_cb_idx = routing.RegisterTransitCallback(time_cb)
    horizon = 24 * 60
    routing.AddDimension(time_cb_idx, 60, horizon, False, "Time")
    time_dim = routing.GetDimensionOrDie("Time")

    for node in range(1, n_stops + 1):
        idx = manager.NodeToIndex(node)
        time_dim.CumulVar(idx).SetRange(windows[node][0], windows[node][1])

    for v_idx in range(n_veh):
        start_idx = routing.Start(v_idx)
        end_idx = routing.End(v_idx)
        time_dim.CumulVar(start_idx).SetRange(veh_start_by[v_idx], default_end)
        time_dim.CumulVar(end_idx).SetRange(default_start, veh_return_by[v_idx])

    # 未割当許容 (高ペナルティ)
    for node in range(1, n_stops + 1):
        idx = manager.NodeToIndex(node)
        routing.AddDisjunction([idx], 100000)

    # 求解
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = time_limit

    sol = routing.SolveWithParameters(params)
    if not sol:
        return {"success": False, "msg": "no solution found"}

    assignments = []
    used_real = 0
    used_charter = 0
    for v_idx in range(n_veh):
        if v_idx < n_real:
            v_meta = vehicles[v_idx]
            v_id = v_meta.get("id")
        else:
            v_meta = {"id": f"庸車-{v_idx - n_real + 1}", "company": "庸車", "vehicle_type": "庸車4t想定"}
            v_id = v_meta["id"]
        idx = routing.Start(v_idx)
        route_stops = []
        seq = 0
        total_sai = 0
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node != 0:
                seq += 1
                t_var = time_dim.CumulVar(idx)
                t_min = sol.Min(t_var)
                hh, mm = divmod(t_min, 60)
                eta = f"{hh:02d}:{mm:02d}"
                route_stops.append({
                    "stop_id": stops[node - 1].get("id"),
                    "sequence": seq,
                    "eta": eta,
                    "site_name": stops[node - 1].get("site_name"),
                    "address": stops[node - 1].get("address"),
                    "sai": stops[node - 1].get("sai", 0),
                    "qty": stops[node - 1].get("qty", 0),
                    "time_spec": stops[node - 1].get("time_spec"),
                })
                total_sai += stops[node - 1].get("sai", 0)
            idx = sol.Value(routing.NextVar(idx))

        if route_stops:
            if v_idx < n_real:
                used_real += 1
            else:
                used_charter += 1
            # 帰着時刻
            end_time_var = time_dim.CumulVar(routing.End(v_idx))
            ret_min = sol.Min(end_time_var)
            ret_h, ret_m = divmod(ret_min, 60)
            assignments.append({
                "vehicle_id": v_id,
                "company": v_meta.get("company"),
                "vehicle_type": v_meta.get("vehicle_type"),
                "is_charter": v_idx >= n_real,
                "stops": route_stops,
                "total_sai": total_sai,
                "capacity": veh_capacity[v_idx],
                "return_eta": f"{ret_h:02d}:{ret_m:02d}",
            })

    # 未割当
    unassigned = []
    for node in range(1, n_stops + 1):
        idx = manager.NodeToIndex(node)
        if sol.Value(routing.NextVar(idx)) == idx:
            s = stops[node - 1]
            unassigned.append({"stop_id": s.get("id"), "site_name": s.get("site_name"), "sai": s.get("sai"), "reason": "容量超過 or 時間窓"})

    return {
        "success": True,
        "assignments": assignments,
        "unassigned": unassigned,
        "stats": {
            "total_stops": n_stops,
            "assigned_stops": n_stops - len(unassigned),
            "vehicles_used_real": used_real,
            "vehicles_used_charter": used_charter,
            "total_sai_assigned": sum(a["total_sai"] for a in assignments),
        },
    }


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        out = solve(payload)
    except Exception as e:
        out = {"success": False, "msg": f"solver exception: {e}"}
    json.dump(out, sys.stdout, ensure_ascii=False)
