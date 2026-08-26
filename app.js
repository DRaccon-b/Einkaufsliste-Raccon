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
    let sortableInstances = [];

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

    function render() {
      const query = searchInput.value.trim().toLowerCase();
      let filtered = query ? allItems.filter((item) => item.text.toLowerCase().includes(query)) : allItems;

      if (hideCheckedFilter.checked) {
        filtered = filtered.filter((item) => !item.checked);
      }

      for (const instance of sortableInstances) instance.destroy();
      sortableInstances = [];

      categoriesEl.innerHTML = "";
      emptyState.hidden = filtered.length > 0;

      const categories = new Map();
      for (const item of filtered) {
        const category = item.category || "Sonstiges";
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(item);
      }

      categoryList.innerHTML = "";
      for (const category of new Set(allItems.map((i) => i.category || "Sonstiges"))) {
        const option = document.createElement("option");
        option.value = category;
        categoryList.appendChild(option);
      }

      const collapsedSet = getCollapsedSet();

      for (const [category, categoryItems] of categories) {
        const details = document.createElement("details");
        details.className = "category";
        details.open = query ? true : !collapsedSet.has(category);

        const summary = document.createElement("summary");
        const doneCount = categoryItems.filter((i) => i.checked).length;

        const chevron = document.createElement("span");
        chevron.className = "chevron";
        chevron.textContent = "▸";

        const nameSpan = document.createElement("span");
        nameSpan.className = "category-name";
        nameSpan.textContent = category;

        const countSpan = document.createElement("span");
        countSpan.className = "count";
        countSpan.textContent = `${doneCount}/${categoryItems.length}`;

        summary.append(chevron, nameSpan, countSpan);
        details.appendChild(summary);

        details.addEventListener("toggle", () => {
          setCollapsed(category, !details.open);
        });

        const ul = document.createElement("ul");
        ul.className = "items";

        for (const item of categoryItems) {
          const li = document.createElement("li");
          li.className = [item.checked ? "checked" : "", item.important ? "important" : ""]
            .filter(Boolean)
            .join(" ");
          li.dataset.id = item.id;

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = item.checked;
          checkbox.addEventListener("change", () => {
            item.checked = checkbox.checked;
            li.classList.toggle("checked", item.checked);
            toggleItem(item.id, checkbox.checked);
          });

          const span = document.createElement("span");
          span.className = "item-text";
          span.textContent = item.text;
          span.contentEditable = "true";
          span.spellcheck = false;
          span.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              span.blur();
            }
          });
          span.addEventListener("blur", () => {
            const newText = span.textContent.trim();
            if (!newText) {
              span.textContent = item.text;
              return;
            }
            if (newText === item.text) return;
            item.text = newText;
            updateItemFields(item.id, { text: newText });
          });

          const quantityInput = document.createElement("input");
          quantityInput.type = "text";
          quantityInput.inputMode = "decimal";
          quantityInput.className = "quantity-input";
          quantityInput.value = item.quantity || "";
          quantityInput.addEventListener("change", () => {
            item.quantity = quantityInput.value.trim() || null;
            updateItemFields(item.id, { quantity: item.quantity });
          });

          const unitSelect = document.createElement("select");
          unitSelect.className = "unit-select";
          const unitOptions = ["", "Stk", "g", "kg", "ml", "L", "Bund", "Netz", "Paket", "Dose"];
          for (const u of unitOptions) {
            const option = document.createElement("option");
            option.value = u;
            option.textContent = u;
            unitSelect.appendChild(option);
          }
          unitSelect.value = item.unit || "";
          unitSelect.addEventListener("change", () => {
            item.unit = unitSelect.value || null;
            updateItemFields(item.id, { unit: item.unit });
          });

          const starBtn = document.createElement("button");
          starBtn.className = "star-btn" + (item.important ? " active" : "");
          starBtn.textContent = "★";
          starBtn.title = "Als wichtig markieren";
          starBtn.addEventListener("click", () => {
            item.important = !item.important;
            li.classList.toggle("important", item.important);
            starBtn.classList.toggle("active", item.important);
            toggleImportant(item.id, item.important);
          });

          const deleteBtn = document.createElement("button");
          deleteBtn.className = "delete-btn";
          deleteBtn.textContent = "✕";
          deleteBtn.addEventListener("click", () => {
            allItems = allItems.filter((i) => i.id !== item.id);
            li.remove();
            deleteItem(item.id);
          });

          li.append(checkbox, span, quantityInput, unitSelect, starBtn, deleteBtn);
          ul.appendChild(li);
        }

        details.appendChild(ul);
        categoriesEl.appendChild(details);

        if (!query && !hideCheckedFilter.checked && window.Sortable) {
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
    }

    async function persistOrder(orderedIds) {
      const updates = orderedIds.map((id, index) =>
        supabase.from("shopping_items").update({ position: index }).eq("id", id)
      );
      const results = await Promise.all(updates);
      const failed = results.find((r) => r.error);
      if (failed) alert("Konnte Reihenfolge nicht speichern: " + failed.error.message);
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
        loadingState.textContent = "Fehler beim Laden: " + error.message;
        return;
      }

      loadingState.hidden = true;
      renderItems(data);
    }

    async function addItem(text, category) {
      const { error } = await supabase
        .from("shopping_items")
        .insert({ list_id: listId, text, category: category || "Sonstiges", position: Date.now() });
      if (error) alert("Konnte Artikel nicht hinzufügen: " + error.message);
    }

    async function toggleItem(itemId, checked) {
      const { error } = await supabase.from("shopping_items").update({ checked }).eq("id", itemId);
      if (error) alert("Konnte Status nicht ändern: " + error.message);
    }

    async function toggleImportant(itemId, important) {
      const { error } = await supabase.from("shopping_items").update({ important }).eq("id", itemId);
      if (error) alert("Konnte Markierung nicht ändern: " + error.message);
    }

    async function updateItemFields(itemId, fields) {
      const { error } = await supabase.from("shopping_items").update(fields).eq("id", itemId);
      if (error) alert("Konnte Angabe nicht speichern: " + error.message);
    }

    async function deleteItem(itemId) {
      const { error } = await supabase.from("shopping_items").delete().eq("id", itemId);
      if (error) alert("Konnte Artikel nicht löschen: " + error.message);
    }

    async function setAllChecked(checked) {
      const { error } = await supabase.from("shopping_items").update({ checked }).eq("list_id", listId);
      if (error) alert("Konnte Liste nicht aktualisieren: " + error.message);
    }

    function subscribeToChanges() {
      supabase
        .channel(`shopping_items:${listId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "shopping_items", filter: `list_id=eq.${listId}` },
          () => loadItems()
        )
        .subscribe();
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

    createListController("", primaryListId, { showShareLink: true });

    const secondaryListId = await getOrCreateSecondaryListId(primaryListId);
    createListController("-b", secondaryListId, { showShareLink: false });

    const pager = document.getElementById("pager");
    pager.scrollLeft = 0;
    window.addEventListener("pageshow", () => {
      pager.scrollLeft = 0;
    });
  }

  init();
})();
