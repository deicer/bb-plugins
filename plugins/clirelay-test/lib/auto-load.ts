// Решение об автозагрузке списка при раскрытии аккордеона.
// После ошибки — только ручной повтор (⟳): иначе недоступный эндпоинт
// крутил бесконечный цикл ретраев на каждом переключении busy.
export interface AutoLoadState {
  open: boolean;
  loaded: boolean;
  busy: boolean;
  error: string | null;
}

export function shouldAutoLoad(state: AutoLoadState): boolean {
  return state.open && !state.loaded && !state.busy && state.error === null;
}
