(function () {
  const THEME_COLOR_KEY = "einkaufsliste:themeColor";

  // The color picker only ever needs the DOM and localStorage, so it's set
  // up independently of Supabase and still works if config.js is missing.
  function setupSettingsPanel() {
    const homeBtn = document.getElementById("home-btn");
    const settingsBtn = document.getElementById("settings-btn");
    const panel = document.getElementById("settings-panel");
    const swatches = document.querySelectorAll(".theme-swatch");
    if (!homeBtn || !settingsBtn || !panel) return;

    function markActiveSwatch(themeColor) {
      for (const swatch of swatches) {
        swatch.classList.toggle("active", swatch.dataset.themeColor === themeColor);
      }
    }

    function applyThemeColor(themeColor) {
      if (themeColor === "warm") delete document.documentElement.dataset.themeColor;
      else document.documentElement.dataset.themeColor = themeColor;
      markActiveSwatch(themeColor);
    }

    applyThemeColor(localStorage.getItem(THEME_COLOR_KEY) || "warm");

    settingsBtn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      settingsBtn.setAttribute("aria-expanded", String(!panel.hidden));
      // On a long list the gear can sit far down the page — without this,
      // the panel can open just below the visible area and look like
      // nothing happened.
      if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    homeBtn.addEventListener("click", () => {
      panel.hidden = true;
      settingsBtn.setAttribute("aria-expanded", "false");
      document.querySelector(".page-a")?.scrollTo({ top: 0, behavior: "smooth" });
    });

    for (const swatch of swatches) {
      swatch.addEventListener("click", () => {
        const themeColor = swatch.dataset.themeColor;
        localStorage.setItem(THEME_COLOR_KEY, themeColor);
        applyThemeColor(themeColor);
      });
    }
  }

  setupSettingsPanel();

  const config = window.SUPABASE_CONFIG;

  if (!config || !config.url || !config.anonKey || config.url.includes("DEIN-PROJEKT")) {
    document.getElementById("loading-state").textContent =
      "Bitte config.js aus config.example.js erstellen und mit deinen Supabase-Zugangsdaten füllen.";
    return;
  }

  const supabase = window.supabase.createClient(config.url, config.anonKey);

  function el(id) {
    return document.getElementById(id);
  }

  // Shared across both list controllers so an optimistic change made via a
  // mirrored item (owned by the other list) still protects that item's own
  // controller from a stale/delayed realtime read overwriting it.
  const localOverrides = new Map();
  const pendingWrites = new Map();
  const overrideClearTimers = new Map();

  let toastTimer = null;
  function notify(message) {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 4000);
  }

  // Mirrors the server-side sort order: category_order (nulls last),
  // category, position (nulls last), text.
  function compareItems(a, b) {
    const ao = a.category_order ?? Infinity;
    const bo = b.category_order ?? Infinity;
    if (ao !== bo) return ao - bo;
    const byCategory = (a.category || "").localeCompare(b.category || "", "de");
    if (byCategory !== 0) return byCategory;
    const ap = a.position ?? Infinity;
    const bp = b.position ?? Infinity;
    if (ap !== bp) return ap - bp;
    return (a.text || "").localeCompare(b.text || "", "de");
  }

  async function createList() {
    const { data, error } = await supabase.from("shopping_lists").insert({}).select().single();
    if (error) {
      alert("Liste konnte nicht erstellt werden: " + error.message);
      throw error;
    }
    return data.id;
  }

  function getListIdFromUrl() {
    return new URLSearchParams(window.location.search).get("list");
  }

  function setListIdInUrl(listId) {
    const url = new URL(window.location.href);
    url.searchParams.set("list", listId);
    window.history.replaceState({}, "", url);
  }

  async function getOrCreateSecondaryListId(primaryListId) {
    const { data, error } = await supabase
      .from("shopping_lists")
      .select("secondary_list_id")
      .eq("id", primaryListId)
      .single();
    if (error) {
      alert("Konnte zweite Liste nicht laden: " + error.message);
      throw error;
    }
    if (data.secondary_list_id) return data.secondary_list_id;

    const secondaryId = await createList();
    const { error: updateError } = await supabase
      .from("shopping_lists")
      .update({ secondary_list_id: secondaryId })
      .eq("id", primaryListId);
    if (updateError) alert("Konnte zweite Liste nicht verknüpfen: " + updateError.message);
    return secondaryId;
  }

  function createListController(suffix, listId, options) {
    const shareCard = el("share-card" + suffix);
    const shareLinkInput = el("share-link" + suffix);
    const copyLinkBtn = el("copy-link" + suffix);
    const addItemForm = el("add-item-form" + suffix);
    const itemTextInput = el("item-text" + suffix);
    const itemCategoryInput = el("item-category" + suffix);
    const itemCategoryCustomInput = el("item-category-custom" + suffix);
    const searchRow = el("search-row" + suffix);
    const searchInput = el("search-input" + suffix);
    const categoriesEl = el("categories" + suffix);
    const emptyState = el("empty-state" + suffix);
    const loadingState = el("loading-state" + suffix);
    const bulkActions = el("bulk-actions" + suffix);
    const checkAllBtn = el("check-all-btn" + suffix);
    const uncheckAllBtn = el("uncheck-all-btn" + suffix);
    const filterRow = el("filter-row" + suffix);
    const hideCheckedFilter = el("hide-checked-filter" + suffix);

    const lastCategoryKey = "einkaufsliste:lastCategory:" + listId;
    const collapsedKey = "einkaufsliste:collapsed:" + listId;
    const hideCheckedKey = "einkaufsliste:hideChecked:" + listId;

    let allItems = [];
    let mirrorItems = [];
    let sortableInstances = [];
    let renderedCategoryOptions = null;
    const mirror = options && options.mirror;

    function getCollapsedSet() {
      try {
        return new Set(JSON.parse(localStorage.getItem(collapsedKey) || "[]"));
      } catch {
        return new Set();
      }
    }

    function setCollapsed(category, collapsed) {
      const set = getCollapsedSet();
      if (collapsed) set.add(category);
      else set.delete(category);
      localStorage.setItem(collapsedKey, JSON.stringify([...set]));
    }

    function buildItemRow(item, isMirrorCategory) {
      const li = document.createElement("li");
      li.dataset.id = item.id;

      const switchLabel = document.createElement("label");
      switchLabel.className = "switch";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "item-checkbox";
      const switchSlider = document.createElement("span");
      switchSlider.className = "switch-slider";
      switchLabel.append(checkbox, switchSlider);

      const span = document.createElement("span");
      span.className = "item-text";
      span.contentEditable = "true";
      span.spellcheck = false;

      const quantityInput = document.createElement("input");
      quantityInput.type = "text";
      quantityInput.inputMode = "decimal";
      quantityInput.className = "quantity-input";

      const unitSelect = document.createElement("select");
      unitSelect.className = "unit-select";
      const unitOptions = ["", "Stk", "g", "kg", "ml", "L", "Bund", "Netz", "Paket", "Dose"];
      for (const u of unitOptions) {
        const option = document.createElement("option");
        option.value = u;
        option.textContent = u;
        unitSelect.appendChild(option);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.textContent = "✕";

      li.append(switchLabel, span, quantityInput, unitSelect, deleteBtn);

      // Keep SortableJS from swallowing taps on interactive controls.
      for (const control of [switchLabel, span, quantityInput, unitSelect, deleteBtn]) {
        control.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
        control.addEventListener("pointerdown", (e) => e.stopPropagation());
      }

      checkbox.addEventListener("change", () => {
        const current = li._item;
        current.checked = checkbox.checked;
        if (li._isMirror && checkbox.checked) {
          mirrorItems = mirrorItems.filter((i) => i.id !== current.id);
        }
        toggleItem(current.id, checkbox.checked);
        // Re-render synchronously so the "nur unerledigte" filter and the
        // category count reflect the change immediately, not just after the
        // debounced write echoes back over realtime.
        render();
      });

      span.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          span.blur();
        }
      });
      span.addEventListener("blur", () => {
        const current = li._item;
        const newText = span.textContent.trim();
        if (!newText) {
          span.textContent = current.text;
          return;
        }
        if (newText === current.text) return;
        current.text = newText;
        updateItemFields(current.id, { text: newText });
      });

      quantityInput.addEventListener("change", () => {
        const current = li._item;
        current.quantity = quantityInput.value.trim() || null;
        updateItemFields(current.id, { quantity: current.quantity });
      });

      unitSelect.addEventListener("change", () => {
        const current = li._item;
        current.unit = unitSelect.value || null;
        updateItemFields(current.id, { unit: current.unit });
      });

      deleteBtn.addEventListener("click", () => {
        const current = li._item;
        if (li._isMirror) {
          mirrorItems = mirrorItems.filter((i) => i.id !== current.id);
        } else {
          allItems = allItems.filter((i) => i.id !== current.id);
        }
        deleteItem(current.id);
        render();
      });

      updateItemRow(li, item, isMirrorCategory);
      return li;
    }

    // Every DOM write is guarded by an equality check: unconditional writes
    // trigger needless repaints on iOS, which showed up as visible flicker.
    function updateItemRow(li, item, isMirrorCategory) {
      li._item = item;
      li._isMirror = isMirrorCategory;

      const wantedClass = [item.checked ? "checked" : "", item.important ? "important" : ""]
        .filter(Boolean)
        .join(" ");
      if (li.className !== wantedClass) li.className = wantedClass;

      const checkbox = li.querySelector(".item-checkbox");
      if (checkbox.checked !== item.checked) checkbox.checked = item.checked;

      const span = li.querySelector(".item-text");
      if (document.activeElement !== span && span.textContent !== item.text) {
        span.textContent = item.text;
      }

      const quantityInput = li.querySelector(".quantity-input");
      if (document.activeElement !== quantityInput && quantityInput.value !== (item.quantity || "")) {
        quantityInput.value = item.quantity || "";
      }

      const unitSelect = li.querySelector(".unit-select");
      if (document.activeElement !== unitSelect && unitSelect.value !== (item.unit || "")) {
        unitSelect.value = item.unit || "";
      }
    }

    // Populates the category <select> with every category currently in use,
    // plus a "+ Neue Kategorie…" entry that reveals a free-text input. A
    // plain <input list="..."> (datalist) doesn't show a dropdown at all on
    // iOS Safari, so a real <select> is used instead for its native picker.
    function updateCategorySelectOptions() {
      const categoryNames = [...new Set(allItems.map((i) => i.category || "Sonstiges"))].sort((a, b) =>
        a.localeCompare(b, "de")
      );
      const key = categoryNames.join("\n");
      if (key === renderedCategoryOptions) return;
      const isFirstPopulate = renderedCategoryOptions === null;
      renderedCategoryOptions = key;

      const currentValue = itemCategoryInput.value;
      itemCategoryInput.innerHTML = "";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Kategorie";
      itemCategoryInput.appendChild(placeholder);

      for (const category of categoryNames) {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = category;
        itemCategoryInput.appendChild(option);
      }

      const newCategoryOption = document.createElement("option");
      newCategoryOption.value = "__new__";
      newCategoryOption.textContent = "+ Neue Kategorie…";
      itemCategoryInput.appendChild(newCategoryOption);

      // On the very first populate, restore the last-used category from
      // localStorage; afterwards, keep whatever the user already picked.
      const desired = isFirstPopulate ? localStorage.getItem(lastCategoryKey) || "" : currentValue;
      if ([...itemCategoryInput.options].some((o) => o.value === desired)) {
        itemCategoryInput.value = desired;
      }
    }

    function render() {
      const query = searchInput.value.trim().toLowerCase();
      let filtered = query ? allItems.filter((item) => item.text.toLowerCase().includes(query)) : allItems;

      if (hideCheckedFilter.checked) {
        filtered = filtered.filter((item) => !item.checked);
      }

      emptyState.hidden = filtered.length > 0;

      const categories = new Map();
      for (const item of filtered) {
        const category = item.category || "Sonstiges";
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(item);
      }

      if (mirror) {
        const mirrorFiltered = query
          ? mirrorItems.filter((item) => item.text.toLowerCase().includes(query))
          : mirrorItems;
        if (mirrorFiltered.length > 0) {
          categories.set(mirror.categoryName, mirrorFiltered);
        }
      }

      updateCategorySelectOptions();

      const collapsedSet = getCollapsedSet();
      const existingDetails = new Map();
      for (const details of categoriesEl.children) {
        existingDetails.set(details.dataset.category, details);
      }

      let prevDetails = null;
      for (const [category, categoryItems] of categories) {
        const isMirrorCategory = mirror && category === mirror.categoryName;
        let details = existingDetails.get(category);
        let ul;

        if (!details) {
          details = document.createElement("details");
          details.className = "category";
          details.dataset.category = category;
          details.open = query ? true : !collapsedSet.has(category);

          const summary = document.createElement("summary");
          const chevron = document.createElement("span");
          chevron.className = "chevron";
          chevron.textContent = "▸";
          const nameSpan = document.createElement("span");
          nameSpan.className = "category-name";
          nameSpan.textContent = category;
          const countSpan = document.createElement("span");
          countSpan.className = "count";
          summary.append(chevron, nameSpan, countSpan);
          details.appendChild(summary);

          details.addEventListener("toggle", () => {
            setCollapsed(category, !details.open);
          });

          ul = document.createElement("ul");
          ul.className = "items";
          details.appendChild(ul);
        } else {
          existingDetails.delete(category);
          if (query) details.open = true;
          ul = details.querySelector("ul");
        }

        const doneCount = categoryItems.filter((i) => i.checked).length;
        const countText = `${doneCount}/${categoryItems.length}`;
        const countEl = details.querySelector(".count");
        if (countEl.textContent !== countText) countEl.textContent = countText;

        const existingRows = new Map();
        for (const li of ul.children) existingRows.set(li.dataset.id, li);

        // While this list is mid-drag, SortableJS owns the DOM order — only
        // refresh existing rows' content, never reposition or remove rows
        // out from under the gesture. onEnd re-renders once it settles.
        if (ul._dragging) {
          for (const item of categoryItems) {
            const li = existingRows.get(item.id);
            if (li) updateItemRow(li, item, isMirrorCategory);
          }
        } else {
          let prevLi = null;
          for (const item of categoryItems) {
            let li = existingRows.get(item.id);
            if (li) {
              existingRows.delete(item.id);
              updateItemRow(li, item, isMirrorCategory);
            } else {
              li = buildItemRow(item, isMirrorCategory);
            }
            const wantedNext = prevLi ? prevLi.nextSibling : ul.firstChild;
            if (wantedNext !== li) ul.insertBefore(li, wantedNext);
            prevLi = li;
          }
          for (const leftover of existingRows.values()) leftover.remove();
        }

        if (prevDetails) {
          if (prevDetails.nextSibling !== details) categoriesEl.insertBefore(details, prevDetails.nextSibling);
        } else if (categoriesEl.firstChild !== details) {
          categoriesEl.insertBefore(details, categoriesEl.firstChild);
        }
        prevDetails = details;

        // Only tear down and recreate SortableJS when its eligibility
        // actually changes. Recreating it on every render — as before —
        // could destroy the instance out from under an in-progress drag.
        const sortableEligible = !query && !hideCheckedFilter.checked && !isMirrorCategory && !!window.Sortable;
        if (ul._sortableEligible !== sortableEligible) {
          ul._sortableEligible = sortableEligible;
          const existingInstance = sortableInstances.find((i) => i.el === ul);
          if (existingInstance) {
            existingInstance.destroy();
            sortableInstances = sortableInstances.filter((i) => i !== existingInstance);
          }
          if (sortableEligible) {
            const instance = window.Sortable.create(ul, {
              animation: 150,
              delay: 120,
              delayOnTouchOnly: true,
              filter: "input, select, button, .item-text",
              preventOnFilter: false,
              onStart: () => {
                ul._dragging = true;
              },
              onEnd: () => {
                ul._dragging = false;
                persistOrder([...ul.children].map((li) => li.dataset.id));
                render();
              },
            });
            sortableInstances.push(instance);
          }
        }
      }

      for (const leftover of existingDetails.values()) {
        const leftoverUl = leftover.querySelector("ul");
        sortableInstances = sortableInstances.filter((i) => {
          if (i.el === leftoverUl) {
            i.destroy();
            return false;
          }
          return true;
        });
        leftover.remove();
      }
    }

    async function persistOrder(orderedIds) {
      const byId = new Map(allItems.map((i) => [i.id, i]));
      const updates = [];
      orderedIds.forEach((id, index) => {
        const item = byId.get(id);
        if (!item || item.position === index) return;
        item.position = index;
        updates.push(supabase.from("shopping_items").update({ position: index }).eq("id", id));
      });
      if (updates.length === 0) return;

      // Keep the local array in sync with the dropped order, otherwise the next
      // render would briefly snap the rows back to their pre-drag positions.
      allItems.sort(compareItems);

      const results = await Promise.all(updates);
      const failed = results.find((r) => r.error);
      if (failed) {
        notify("Konnte Reihenfolge nicht speichern: " + failed.error.message);
        loadItems();
      }
    }

    function applyOverrides(data) {
      for (const item of data) {
        const overrides = localOverrides.get(item.id);
        if (overrides) Object.assign(item, overrides);
      }
      return data;
    }

    async function loadItems() {
      const { data, error } = await supabase
        .from("shopping_items")
        .select("*")
        .eq("list_id", listId)
        .order("category_order", { ascending: true, nullsFirst: false })
        .order("category", { ascending: true })
        .order("position", { ascending: true })
        .order("text", { ascending: true });

      if (error) {
        // Only surface the error while the initial load is still pending; a
        // failed background resync keeps showing the current data silently.
        if (!loadingState.hidden) loadingState.textContent = "Fehler beim Laden: " + error.message;
        return;
      }

      loadingState.hidden = true;
      allItems = applyOverrides(data);
      render();
    }

    async function loadMirrorItems() {
      if (!mirror) return;
      const { data, error } = await supabase
        .from("shopping_items")
        .select("*")
        .eq("list_id", mirror.listId)
        .eq("checked", false)
        .order("category_order", { ascending: true, nullsFirst: false })
        .order("category", { ascending: true })
        .order("position", { ascending: true })
        .order("text", { ascending: true });

      if (error) return;
      mirrorItems = applyOverrides(data);
      render();
    }

    // Realtime events carry the committed row, so the list can be patched in
    // place instead of refetching everything — fewer requests, fewer renders,
    // and no window for a stale read to race the patch.
    function applyRealtimeEvent(payload) {
      if (payload.eventType === "DELETE") {
        const id = payload.old && payload.old.id;
        if (!id) return loadItems();
        allItems = allItems.filter((i) => i.id !== id);
        render();
        return;
      }
      const row = payload.new;
      if (!row || !row.id) return loadItems();
      applyOverrides([row]);
      let existing = allItems.find((i) => i.id === row.id);
      if (!existing && payload.eventType === "INSERT") {
        // This may be the server echo of our own optimistic addItem() insert,
        // still sitting under its temporary id — adopt it instead of adding
        // a second, momentarily duplicate row.
        existing = allItems.find(
          (i) => i._pending && i.text === row.text && i.category === row.category && i.position === row.position
        );
      }
      if (existing) {
        Object.assign(existing, row);
        delete existing._pending;
      } else {
        allItems.push(row);
      }
      allItems.sort(compareItems);
      render();
    }

    function applyMirrorRealtimeEvent(payload) {
      if (payload.eventType === "DELETE") {
        const id = payload.old && payload.old.id;
        if (!id) return loadMirrorItems();
        mirrorItems = mirrorItems.filter((i) => i.id !== id);
        render();
        return;
      }
      const row = payload.new;
      if (!row || !row.id) return loadMirrorItems();
      applyOverrides([row]);
      if (row.checked) {
        mirrorItems = mirrorItems.filter((i) => i.id !== row.id);
      } else {
        const existing = mirrorItems.find((i) => i.id === row.id);
        if (existing) Object.assign(existing, row);
        else mirrorItems.push(row);
        mirrorItems.sort(compareItems);
      }
      render();
    }

    async function addItem(text, category) {
      // Show the new item immediately instead of waiting for a full
      // round-trip; applyRealtimeEvent() reconciles it with the server-
      // confirmed row once either the insert response or its realtime
      // echo arrives, whichever comes first.
      const tempId = "temp-" + Math.random().toString(36).slice(2, 10);
      const optimisticItem = {
        id: tempId,
        list_id: listId,
        category: category || "Sonstiges",
        category_order: null,
        position: Date.now(),
        text,
        quantity: null,
        unit: null,
        checked: false,
        important: false,
        _pending: true,
      };
      allItems.push(optimisticItem);
      allItems.sort(compareItems);
      render();

      const { data, error } = await supabase
        .from("shopping_items")
        .insert({ list_id: listId, text, category: optimisticItem.category, position: optimisticItem.position })
        .select()
        .single();

      const index = allItems.findIndex((i) => i.id === tempId);
      if (error) {
        notify("Konnte Artikel nicht hinzufügen: " + error.message);
        if (index !== -1) allItems.splice(index, 1);
        render();
        return;
      }
      if (index === -1) return; // realtime echo already reconciled it

      if (allItems.some((i) => i.id === data.id)) {
        allItems.splice(index, 1); // realtime echo won the race; drop our temp copy
      } else {
        allItems[index] = data;
      }
      allItems.sort(compareItems);
      render();
    }

    // Clears just the given fields from an item's override once they're safely
    // confirmed, leaving any other still-pending overrides for that item intact.
    function clearOverrideFields(itemId, fields) {
      const current = localOverrides.get(itemId);
      if (!current) return;
      for (const field of Object.keys(fields)) delete current[field];
      if (Object.keys(current).length === 0) localOverrides.delete(itemId);
    }

    function cancelOverrideClear(itemId, fields) {
      const clearKey = itemId + ":" + Object.keys(fields).sort().join(",") + ":clear";
      const existing = overrideClearTimers.get(clearKey);
      if (existing) {
        clearTimeout(existing);
        overrideClearTimers.delete(clearKey);
      }
      return clearKey;
    }

    // Keeps an override in place for a grace period after its write is
    // confirmed, so a delayed/out-of-order read arriving in that window
    // can't briefly show stale data — the exact race behind the original
    // checkbox-flicker bug.
    function scheduleOverrideClear(itemId, fields, delay) {
      const clearKey = cancelOverrideClear(itemId, fields);
      const timer = setTimeout(() => {
        overrideClearTimers.delete(clearKey);
        clearOverrideFields(itemId, fields);
      }, delay);
      overrideClearTimers.set(clearKey, timer);
    }

    function writeFieldsDebounced(itemId, fields, errorMessage) {
      const key = itemId + ":" + Object.keys(fields).sort().join(",");
      localOverrides.set(itemId, { ...(localOverrides.get(itemId) || {}), ...fields });
      cancelOverrideClear(itemId, fields);

      const existing = pendingWrites.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(async () => {
        pendingWrites.delete(key);

        // If the override no longer matches this write's values, a newer
        // toggle superseded it while we were waiting — that write wins.
        const stillCurrent = () => {
          const current = localOverrides.get(itemId);
          return !!current && Object.keys(fields).every((f) => current[f] === fields[f]);
        };

        const maxAttempts = 3;
        let error = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (!stillCurrent()) return;
          ({ error } = await supabase.from("shopping_items").update(fields).eq("id", itemId));
          if (!error) break;
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
          }
        }
        if (error) {
          notify(errorMessage + error.message);
          clearOverrideFields(itemId, fields);
          loadItems();
          loadMirrorItems();
          return;
        }

        scheduleOverrideClear(itemId, fields, 4000);
      }, 250);
      pendingWrites.set(key, timer);
    }

    function toggleItem(itemId, checked) {
      writeFieldsDebounced(itemId, { checked }, "Konnte Status nicht ändern: ");
    }

    function updateItemFields(itemId, fields) {
      writeFieldsDebounced(itemId, fields, "Konnte Angabe nicht speichern: ");
    }

    async function deleteItem(itemId) {
      const { error } = await supabase.from("shopping_items").delete().eq("id", itemId);
      if (error) {
        notify("Konnte Artikel nicht löschen: " + error.message);
        loadItems();
        loadMirrorItems();
      }
    }

    async function setAllChecked(checked) {
      for (const item of allItems) {
        localOverrides.set(item.id, { ...(localOverrides.get(item.id) || {}), checked });
        cancelOverrideClear(item.id, { checked });
      }
      const { error } = await supabase.from("shopping_items").update({ checked }).eq("list_id", listId);
      if (error) {
        notify("Konnte Liste nicht aktualisieren: " + error.message);
        for (const item of allItems) clearOverrideFields(item.id, { checked });
        loadItems();
        return;
      }
      for (const item of allItems) scheduleOverrideClear(item.id, { checked }, 4000);
    }

    function subscribeToChanges() {
      let ownSubscribedOnce = false;
      supabase
        .channel(`shopping_items:${listId}:own${suffix}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "shopping_items", filter: `list_id=eq.${listId}` },
          applyRealtimeEvent
        )
        .subscribe((status) => {
          // After a reconnect (iOS suspends sockets in the background) events
          // may have been missed — refetch once to get back in sync.
          if (status === "SUBSCRIBED") {
            if (ownSubscribedOnce) loadItems();
            ownSubscribedOnce = true;
          }
        });

      if (mirror) {
        let mirrorSubscribedOnce = false;
        supabase
          .channel(`shopping_items:${mirror.listId}:mirror${suffix}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "shopping_items", filter: `list_id=eq.${mirror.listId}` },
            applyMirrorRealtimeEvent
          )
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              if (mirrorSubscribedOnce) loadMirrorItems();
              mirrorSubscribedOnce = true;
            }
          });
      }
    }

    async function init() {
      addItemForm.hidden = false;
      searchRow.hidden = false;
      filterRow.hidden = false;
      bulkActions.hidden = false;

      if (options && options.showShareLink) {
        shareLinkInput.value = window.location.href;
        shareCard.hidden = false;
        copyLinkBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(shareLinkInput.value);
          copyLinkBtn.textContent = "Kopiert!";
          setTimeout(() => (copyLinkBtn.textContent = "Kopieren"), 1500);
        });
      }

      itemCategoryInput.addEventListener("change", () => {
        const showCustom = itemCategoryInput.value === "__new__";
        itemCategoryCustomInput.hidden = !showCustom;
        if (showCustom) itemCategoryCustomInput.focus();
      });

      addItemForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = itemTextInput.value.trim();
        const isNewCategory = itemCategoryInput.value === "__new__";
        const category = isNewCategory ? itemCategoryCustomInput.value.trim() : itemCategoryInput.value;
        if (!text) return;
        if (mirror && category === mirror.categoryName) {
          notify(`"${category}" ist als Kategoriename für die andere Liste reserviert.`);
          return;
        }
        itemTextInput.value = "";
        if (isNewCategory) {
          itemCategoryCustomInput.value = "";
          itemCategoryCustomInput.hidden = true;
          itemCategoryInput.value = "";
        }
        if (category) localStorage.setItem(lastCategoryKey, category);
        await addItem(text, category);
      });

      searchInput.addEventListener("input", () => render());

      hideCheckedFilter.checked = localStorage.getItem(hideCheckedKey) === "1";
      hideCheckedFilter.addEventListener("change", () => {
        localStorage.setItem(hideCheckedKey, hideCheckedFilter.checked ? "1" : "0");
        render();
      });

      checkAllBtn.addEventListener("click", () => {
        if (!confirm("Wirklich alle Artikel abhaken?")) return;
        for (const item of allItems) item.checked = true;
        render();
        setAllChecked(true);
      });
      uncheckAllBtn.addEventListener("click", () => {
        if (!confirm("Wirklich alle Artikel zurücksetzen?")) return;
        for (const item of allItems) item.checked = false;
        render();
        setAllChecked(false);
      });

      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          loadItems();
          loadMirrorItems();
        }
      });

      await Promise.all([loadItems(), loadMirrorItems()]);
      subscribeToChanges();
    }

    init();
  }

  function showVersionFromScriptTag() {
    const appScript = document.querySelector('script[src*="app.js"]');
    const version = appScript ? new URL(appScript.src).searchParams.get("v") : null;
    if (!version) return;
    for (const tag of document.querySelectorAll(".version-tag")) {
      tag.textContent = "v" + version;
    }
  }

  async function init() {
    showVersionFromScriptTag();

    let primaryListId = getListIdFromUrl();
    if (!primaryListId) {
      primaryListId = await createList();
      setListIdInUrl(primaryListId);
    }

    const secondaryListId = await getOrCreateSecondaryListId(primaryListId);

    createListController("", primaryListId, {
      showShareLink: true,
      mirror: { listId: secondaryListId, categoryName: "Reste vom Rewe" },
    });
    createListController("-b", secondaryListId, {
      showShareLink: false,
      mirror: { listId: primaryListId, categoryName: "Reste von Aldi" },
    });

    const pager = document.getElementById("pager");
    pager.scrollLeft = 0;
    window.addEventListener("pageshow", () => {
      pager.scrollLeft = 0;
    });
  }

  init();
})();
