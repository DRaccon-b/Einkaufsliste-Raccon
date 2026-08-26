(function () {
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

  function debugLog() {}

  // Shared across both list controllers so an optimistic change made via a
  // mirrored item (owned by the other list) still protects that item's own
  // controller from a stale/delayed realtime read overwriting it.
  const localOverrides = new Map();
  const pendingWrites = new Map();
  const overrideClearTimers = new Map();

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
    const categoryList = el("category-list" + suffix);
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

    function renderItems(items) {
      allItems = items;
      render();
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

      const starBtn = document.createElement("button");
      starBtn.className = "star-btn";
      starBtn.textContent = "★";
      starBtn.title = "Als wichtig markieren";

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.textContent = "✕";

      li.append(switchLabel, span, quantityInput, unitSelect, starBtn, deleteBtn);

      for (const el of [switchLabel, span, quantityInput, unitSelect, starBtn, deleteBtn]) {
        el.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
      }

      checkbox.addEventListener("change", () => {
        const current = li._item;
        debugLog(`[${suffix || "A"}] CHANGE event: "${current.text}" -> ${checkbox.checked}`);
        current.checked = checkbox.checked;
        if (li._isMirror && checkbox.checked) {
          mirrorItems = mirrorItems.filter((i) => i.id !== current.id);
          li.remove();
        } else {
          li.classList.toggle("checked", current.checked);
        }
        toggleItem(current.id, checkbox.checked);
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

      starBtn.addEventListener("click", () => {
        const current = li._item;
        current.important = !current.important;
        li.classList.toggle("important", current.important);
        starBtn.classList.toggle("active", current.important);
        toggleImportant(current.id, current.important);
      });

      deleteBtn.addEventListener("click", () => {
        const current = li._item;
        if (li._isMirror) {
          mirrorItems = mirrorItems.filter((i) => i.id !== current.id);
        } else {
          allItems = allItems.filter((i) => i.id !== current.id);
        }
        li.remove();
        deleteItem(current.id);
      });

      updateItemRow(li, item, isMirrorCategory);
      return li;
    }

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

      const starBtn = li.querySelector(".star-btn");
      starBtn.classList.toggle("active", !!item.important);
    }

    function render() {
      const obstNow = allItems.find((i) => i.text === "Obst");
      if (obstNow) debugLog(`[${suffix || "A"}] render() called, Obst.checked=${obstNow.checked}`);
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

      categoryList.innerHTML = "";
      for (const category of new Set(allItems.map((i) => i.category || "Sonstiges"))) {
        const option = document.createElement("option");
        option.value = category;
        categoryList.appendChild(option);
      }

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

        if (prevDetails) {
          if (prevDetails.nextSibling !== details) categoriesEl.insertBefore(details, prevDetails.nextSibling);
        } else if (categoriesEl.firstChild !== details) {
          categoriesEl.insertBefore(details, categoriesEl.firstChild);
        }
        prevDetails = details;

        for (const instance of sortableInstances) {
          if (instance.el === ul) instance.destroy();
        }
        sortableInstances = sortableInstances.filter((i) => i.el !== ul);
        if (!query && !hideCheckedFilter.checked && !isMirrorCategory && window.Sortable) {
          const instance = window.Sortable.create(ul, {
            animation: 150,
            delay: 120,
            delayOnTouchOnly: true,
            filter: "input, select, button, .item-text",
            preventOnFilter: false,
            onEnd: () => persistOrder([...ul.children].map((li) => li.dataset.id)),
          });
          sortableInstances.push(instance);
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
      const updates = orderedIds.map((id, index) =>
        supabase.from("shopping_items").update({ position: index }).eq("id", id)
      );
      const results = await Promise.all(updates);
      const failed = results.find((r) => r.error);
      if (failed) alert("Konnte Reihenfolge nicht speichern: " + failed.error.message);
    }

    function applyOverrides(data) {
      for (const item of data) {
        const overrides = localOverrides.get(item.id);
        if (overrides) {
          debugLog(`[${suffix || "A"}] OVERRIDE applied to "${item.text}": ${JSON.stringify(overrides)} (server had checked=${item.checked})`);
          Object.assign(item, overrides);
        }
      }
      return data;
    }

    async function loadItems() {
      debugLog(`[${suffix || "A"}] loadItems() fetching...`);
      const { data, error } = await supabase
        .from("shopping_items")
        .select("*")
        .eq("list_id", listId)
        .order("category_order", { ascending: true, nullsFirst: false })
        .order("category", { ascending: true })
        .order("position", { ascending: true })
        .order("text", { ascending: true });

      if (error) {
        loadingState.textContent = "Fehler beim Laden: " + error.message;
        return;
      }

      const obst = data.find((i) => i.text === "Obst");
      if (obst) debugLog(`[${suffix || "A"}] loadItems() got Obst checked=${obst.checked}`);
      loadingState.hidden = true;
      renderItems(applyOverrides(data));
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

      if (error) {
        alert("Konnte '" + mirror.categoryName + "' nicht laden: " + error.message);
        return;
      }
      mirrorItems = applyOverrides(data);
      render();
    }

    async function addItem(text, category) {
      const { error } = await supabase
        .from("shopping_items")
        .insert({ list_id: listId, text, category: category || "Sonstiges", position: Date.now() });
      if (error) alert("Konnte Artikel nicht hinzufügen: " + error.message);
    }

    function writeFieldsDebounced(itemId, fields, errorMessage) {
      const key = itemId + ":" + Object.keys(fields).sort().join(",");
      localOverrides.set(itemId, { ...(localOverrides.get(itemId) || {}), ...fields });
      debugLog(`[${suffix || "A"}] writeFieldsDebounced scheduled: ${JSON.stringify(fields)} for item ${itemId.slice(0, 8)}`);

      const clearKey = itemId + ":" + Object.keys(fields).sort().join(",") + ":clear";
      const existingClear = overrideClearTimers.get(clearKey);
      if (existingClear) clearTimeout(existingClear);

      const existing = pendingWrites.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(async () => {
        pendingWrites.delete(key);
        debugLog(`[${suffix || "A"}] WRITE sending: ${JSON.stringify(fields)} for item ${itemId.slice(0, 8)}`);
        const { error } = await supabase.from("shopping_items").update(fields).eq("id", itemId);
        debugLog(`[${suffix || "A"}] WRITE done: ${JSON.stringify(fields)} error=${error ? error.message : "none"}`);
        if (error) {
          alert(errorMessage + error.message);
        }
        const clearTimer = setTimeout(() => {
          debugLog(`[${suffix || "A"}] override CLEARED for item ${itemId.slice(0, 8)}: ${JSON.stringify(fields)}`);
          overrideClearTimers.delete(clearKey);
          const current = localOverrides.get(itemId);
          if (current) {
            for (const field of Object.keys(fields)) delete current[field];
            if (Object.keys(current).length === 0) localOverrides.delete(itemId);
          }
        }, 4000);
        overrideClearTimers.set(clearKey, clearTimer);
      }, 250);
      pendingWrites.set(key, timer);
    }

    function toggleItem(itemId, checked) {
      writeFieldsDebounced(itemId, { checked }, "Konnte Status nicht ändern: ");
    }

    function toggleImportant(itemId, important) {
      writeFieldsDebounced(itemId, { important }, "Konnte Markierung nicht ändern: ");
    }

    function updateItemFields(itemId, fields) {
      writeFieldsDebounced(itemId, fields, "Konnte Angabe nicht speichern: ");
    }

    async function deleteItem(itemId) {
      const { error } = await supabase.from("shopping_items").delete().eq("id", itemId);
      if (error) alert("Konnte Artikel nicht löschen: " + error.message);
    }

    async function setAllChecked(checked) {
      for (const item of allItems) localOverrides.set(item.id, { ...(localOverrides.get(item.id) || {}), checked });
      const { error } = await supabase.from("shopping_items").update({ checked }).eq("list_id", listId);
      if (error) alert("Konnte Liste nicht aktualisieren: " + error.message);
      for (const item of allItems) {
        const current = localOverrides.get(item.id);
        if (current) {
          delete current.checked;
          if (Object.keys(current).length === 0) localOverrides.delete(item.id);
        }
      }
    }

    function subscribeToChanges() {
      supabase
        .channel(`shopping_items:${listId}:own${suffix}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "shopping_items", filter: `list_id=eq.${listId}` },
          (payload) => {
            debugLog(`[${suffix || "A"}] REALTIME own event: ${payload.eventType} on "${payload.new?.text || payload.old?.text}" checked=${payload.new?.checked}`);
            loadItems();
          }
        )
        .subscribe();

      if (mirror) {
        supabase
          .channel(`shopping_items:${mirror.listId}:mirror${suffix}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "shopping_items", filter: `list_id=eq.${mirror.listId}` },
            (payload) => {
              debugLog(`[${suffix || "A"}] REALTIME mirror event: ${payload.eventType} on "${payload.new?.text || payload.old?.text}" checked=${payload.new?.checked}`);
              loadMirrorItems();
            }
          )
          .subscribe();
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

      itemCategoryInput.value = localStorage.getItem(lastCategoryKey) || "";

      addItemForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = itemTextInput.value.trim();
        const category = itemCategoryInput.value.trim();
        if (!text) return;
        itemTextInput.value = "";
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

      await loadItems();
      await loadMirrorItems();
      subscribeToChanges();
    }

    init();
  }

  async function init() {
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
